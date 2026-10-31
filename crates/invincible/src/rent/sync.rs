//! S3-compatible object store (Cloudflare R2, path-style) over reqwest and SigV4.
//! Credentials are the ones the caller already read from files. They are not read from the
//! environment here, and they are scrubbed from errors.

use std::time::Duration;

use chrono::Utc;
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

use super::secrets::scrub;

type HmacSha256 = Hmac<Sha256>;

#[cfg(test)]
const EMPTY_HASH: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

pub trait ObjectStore: Send + Sync {
    fn put<'a>(&'a self, key: &'a str, body: &'a [u8]) -> StoreFut<'a, ()>;
    fn exists<'a>(&'a self, key: &'a str) -> StoreFut<'a, bool>;
    fn list_prefix<'a>(&'a self, prefix: &'a str) -> StoreFut<'a, Vec<String>>;
}

pub type StoreFut<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, String>> + Send + 'a>>;

pub struct S3 {
    client: reqwest::Client,
    endpoint: String,
    bucket: String,
    region: String,
    access: String,
    secret: String,
    secrets: Vec<String>,
}

impl S3 {
    pub fn new(endpoint: &str, bucket: &str, region: &str, access: String, secret: String) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| format!("object store client: {e}"))?;
        let secrets = vec![access.clone(), secret.clone()];
        Ok(Self {
            client,
            endpoint: endpoint.trim_end_matches('/').to_owned(),
            bucket: bucket.to_owned(),
            region: if region.is_empty() { "auto".to_owned() } else { region.to_owned() },
            access,
            secret,
            secrets,
        })
    }

    fn scrubbed(&self, err: impl std::fmt::Display) -> String {
        scrub(&err.to_string(), &self.secrets)
    }

    fn url(&self, key: &str, query: &str) -> Result<reqwest::Url, String> {
        let path = object_path(&self.bucket, key);
        let mut url = format!("{}{path}", self.endpoint);
        if !query.is_empty() {
            url.push('?');
            url.push_str(query);
        }
        reqwest::Url::parse(&url).map_err(|e| self.scrubbed(e))
    }

    async fn send(
        &self,
        method: reqwest::Method,
        url: reqwest::Url,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response, String> {
        let payload = body.as_deref().unwrap_or(b"");
        let now = Utc::now();
        let hash = hex_sha256(payload);
        let host = host_header(&url);
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let canonical_uri = url.path().to_owned();
        let auth = authorization(&Signed {
            access: &self.access,
            secret: &self.secret,
            region: &self.region,
            method: method.as_str(),
            canonical_uri: &canonical_uri,
            query: url.query().unwrap_or(""),
            host: &host,
            amz_date: &amz_date,
            payload_hash: &hash,
            extra: &[],
        });
        let mut request = self
            .client
            .request(method, url)
            .header("authorization", auth)
            .header("x-amz-date", amz_date)
            .header("x-amz-content-sha256", hash)
            .header("host", host);
        if let Some(body) = body {
            request = request.header("content-type", "application/json").body(body);
        }
        request.send().await.map_err(|e| self.scrubbed(e))
    }
}

impl ObjectStore for S3 {
    fn put<'a>(&'a self, key: &'a str, body: &'a [u8]) -> StoreFut<'a, ()> {
        Box::pin(async move {
            let url = self.url(key, "")?;
            let response = self.send(reqwest::Method::PUT, url, Some(body.to_vec())).await?;
            let status = response.status();
            if status.is_success() {
                return Ok(());
            }
            let text = response.text().await.unwrap_or_default();
            Err(self.scrubbed(format!("s3 put {key}: {status} {}", clip(&text))))
        })
    }

    fn exists<'a>(&'a self, key: &'a str) -> StoreFut<'a, bool> {
        Box::pin(async move {
            let url = self.url(key, "")?;
            let response = self.send(reqwest::Method::HEAD, url, None).await?;
            let status = response.status();
            if status.is_success() {
                return Ok(true);
            }
            if status.as_u16() == 404 {
                return Ok(false);
            }
            Err(self.scrubbed(format!("s3 head {key}: {status}")))
        })
    }

    fn list_prefix<'a>(&'a self, prefix: &'a str) -> StoreFut<'a, Vec<String>> {
        Box::pin(async move {
            let mut keys = Vec::new();
            let mut token: Option<String> = None;
            loop {
                let mut query = format!("list-type=2&prefix={}", aws_encode(prefix));
                if let Some(token) = &token {
                    query.push_str(&format!("&continuation-token={}", aws_encode(token)));
                }
                let url = self.url("", &query)?;
                let response = self.send(reqwest::Method::GET, url, None).await?;
                let status = response.status();
                let text = response.text().await.map_err(|e| self.scrubbed(e))?;
                if !status.is_success() {
                    return Err(self.scrubbed(format!("s3 list {prefix}: {status} {}", clip(&text))));
                }
                keys.extend(keys_from_list(&text));
                match next_page(&text) {
                    Some(next) => token = Some(next),
                    None => break,
                }
            }
            Ok(keys)
        })
    }
}

fn next_page(xml: &str) -> Option<String> {
    let truncated = xml.contains("<IsTruncated>true</IsTruncated>");
    if !truncated {
        return None;
    }
    let start = xml.find("<NextContinuationToken>")? + "<NextContinuationToken>".len();
    let end = xml[start..].find("</NextContinuationToken>")? + start;
    let token = decode_xml(&xml[start..end]);
    (!token.is_empty()).then_some(token)
}

fn keys_from_list(xml: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<Key>") {
        rest = &rest[start + 5..];
        if let Some(end) = rest.find("</Key>") {
            keys.push(decode_xml(&rest[..end]));
            rest = &rest[end + 6..];
        } else {
            break;
        }
    }
    keys
}

fn decode_xml(text: &str) -> String {
    text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'")
}

fn clip(text: &str) -> String {
    let text = text.trim();
    if text.len() > 180 { text.chars().take(180).collect() } else { text.to_owned() }
}

fn host_header(url: &reqwest::Url) -> String {
    match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_owned(),
        _ => String::new(),
    }
}

struct Signed<'a> {
    access: &'a str,
    secret: &'a str,
    region: &'a str,
    method: &'a str,
    canonical_uri: &'a str,
    query: &'a str,
    host: &'a str,
    amz_date: &'a str,
    payload_hash: &'a str,
    extra: &'a [(&'a str, &'a str)],
}

fn authorization(signed: &Signed<'_>) -> String {
    let date = &signed.amz_date[..8];
    let scope = format!("{date}/{}/s3/aws4_request", signed.region);
    let (canonical, names) = canonical_request(
        signed.method,
        signed.canonical_uri,
        signed.query,
        signed.host,
        signed.amz_date,
        signed.payload_hash,
        signed.extra,
    );
    let to_sign = format!("AWS4-HMAC-SHA256\n{}\n{scope}\n{}", signed.amz_date, hex_sha256(canonical.as_bytes()));
    let signature = hex(&hmac_sha256(&signing_key(signed.secret, date, signed.region, "s3"), to_sign.as_bytes()));
    format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={names}, Signature={signature}", signed.access)
}

fn canonical_request(
    method: &str,
    canonical_uri: &str,
    query: &str,
    host: &str,
    amz_date: &str,
    payload_hash: &str,
    extra: &[(&str, &str)],
) -> (String, String) {
    let canonical_query = canonical_query(query);
    let mut headers: Vec<(&str, &str)> =
        vec![("host", host), ("x-amz-content-sha256", payload_hash), ("x-amz-date", amz_date)];
    headers.extend_from_slice(extra);
    headers.sort_by(|a, b| a.0.cmp(b.0));
    let canonical_headers: String = headers.iter().map(|(name, value)| format!("{name}:{}\n", value.trim())).collect();
    let signed = headers.iter().map(|(name, _)| *name).collect::<Vec<_>>().join(";");
    let canonical =
        format!("{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed}\n{payload_hash}");
    (canonical, signed)
}

fn object_path(bucket: &str, key: &str) -> String {
    let bucket = aws_encode(bucket);
    if key.is_empty() {
        format!("/{bucket}")
    } else {
        let key = key.split('/').map(aws_encode).collect::<Vec<_>>().join("/");
        format!("/{bucket}/{key}")
    }
}

fn canonical_query(query: &str) -> String {
    let mut pairs: Vec<(String, String)> = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (aws_encode(&percent_decode(name)), aws_encode(&percent_decode(value)))
        })
        .collect();
    pairs.sort();
    pairs.into_iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("&")
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or(""), 16)
        {
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(if bytes[index] == b'+' { b' ' } else { bytes[index] });
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn aws_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let date_key = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let region_key = hmac_sha256(&date_key, region.as_bytes());
    let service_key = hmac_sha256(&region_key, service.as_bytes());
    hmac_sha256(&service_key, b"aws4_request")
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn hex_sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_published_aws_get_vector_signs_the_same_way() {
        let url = reqwest::Url::parse("https://examplebucket.s3.amazonaws.com/test.txt").unwrap();
        let extra = [("range", "bytes=0-9")];
        let signed = Signed {
            access: "AKIDEXAMPLE",
            secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            region: "us-east-1",
            method: "GET",
            canonical_uri: url.path(),
            query: "",
            host: "examplebucket.s3.amazonaws.com",
            amz_date: "20130524T000000Z",
            payload_hash: EMPTY_HASH,
            extra: &extra,
        };
        let header = authorization(&signed);
        let (canonical, _) = canonical_request(
            signed.method,
            signed.canonical_uri,
            signed.query,
            signed.host,
            signed.amz_date,
            signed.payload_hash,
            signed.extra,
        );
        assert!(canonical.contains("GET\n/test.txt\n\n"), "{canonical}");
        assert!(
            header.ends_with("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"),
            "{header}\n{canonical}"
        );
    }

    #[test]
    fn a_truncated_list_names_the_next_page() {
        assert!(next_page("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>").is_none());
        assert_eq!(
            next_page("<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>abc&amp;d</NextContinuationToken></ListBucketResult>").as_deref(),
            Some("abc&d")
        );
        assert!(next_page("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>").is_none());
    }

    #[test]
    fn a_list_body_yields_the_keys() {
        let xml = "<ListBucketResult><Contents><Key>projects/a/workspace/x</Key></Contents><Contents><Key>a &amp; b</Key></Contents></ListBucketResult>";
        assert_eq!(keys_from_list(xml), vec!["projects/a/workspace/x".to_owned(), "a & b".to_owned()]);
    }
}
