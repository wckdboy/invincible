//! Redaction before a request leaves the node (spec/redaction.md): a port of Autobot's
//! `PiiDetector` (detection) and `RedactionVault` (placeholders `[KIND_N]`, restoring them in
//! answers, streams too), so the phone and the node hide the same things.
//!
//! The `regex` crate has no look-around or back-references, so each pattern with look-around
//! matches its one character of context instead and captures the core in group 1. Leftmost-first
//! matching picks the same core a backtracking engine with look-around would.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    Person,
    Email,
    Phone,
    Address,
    Card,
    Iban,
    Account,
}

const KINDS: [Kind; 7] = [Kind::Person, Kind::Email, Kind::Phone, Kind::Address, Kind::Card, Kind::Iban, Kind::Account];

impl Kind {
    pub fn tag(self) -> &'static str {
        match self {
            Self::Person => "PERSON",
            Self::Email => "EMAIL",
            Self::Phone => "PHONE",
            Self::Address => "ADDRESS",
            Self::Card => "CARD",
            Self::Iban => "IBAN",
            Self::Account => "ACCOUNT",
        }
    }

    fn parse(tag: &str) -> Option<Self> {
        KINDS.into_iter().find(|k| k.tag() == tag)
    }

    fn index(self) -> usize {
        KINDS.iter().position(|k| *k == self).expect("a kind")
    }

    /// Matched by its digits (a phone written with other spacing is the same phone).
    fn numeric(self) -> bool {
        matches!(self, Self::Phone | Self::Card | Self::Account)
    }

    /// Plain words: not looked for inside code or links.
    fn wordy(self) -> bool {
        matches!(self, Self::Person | Self::Address)
    }
}

// Priorities: the most reliable rule wins an overlap.
const P_EMAIL: u8 = 0;
const P_IBAN: u8 = 1;
const P_CARD: u8 = 2;
const P_ACCOUNT: u8 = 3;
const P_PHONE_CUED: u8 = 4;
const P_PHONE: u8 = 5;
const P_ADDRESS: u8 = 6;
const P_NAME_CUED: u8 = 7;
const P_NAME_LIST: u8 = 8;

/// One finding: byte range and kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub kind: Kind,
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|e| panic!("redaction pattern: {e}"))
}

// ---------------------------------------------------------------------------------------------
// Patterns. `\w` and `\d` are ASCII, as in Autobot (Java regex without UNICODE_CHARACTER_CLASS).

static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?:^|[^\p{L}\p{N}._%+-])([\p{L}\p{N}][\p{L}\p{N}._%+-]*@[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)*\.\p{L}{2,24})(?:$|[^\p{L}\p{N}-])",
    )
});
static IBAN: LazyLock<Regex> = LazyLock::new(|| re(r"(?:^|[^A-Za-z0-9])([A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]){10,32})"));
static CARD: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?:^|[^A-Za-z0-9_.\-])([0-9](?:[ \-]?[0-9]){12,18})(?:$|[^A-Za-z0-9_\-.]|\.(?:$|[^0-9]))"));

const ACCOUNT_CUES: &str = r"account|acct|a/c|konto(?:nummer)?|kontonr|routing|sort\s+code|customer|kunden(?:nummer|nr)|member(?:ship)?|policy|contract|vertrags?(?:nummer|nr)|passport|reisepass|licen[cs]e|driver'?s\s+licen[cs]e|ssn|social\s+security|tax\s*id|steuer[- ]?id|steuernummer|steuer-?identifikationsnummer|national\s+insurance|nino|bsn|svnr|sozialversicherungsnummer|personalausweis|id\s+card";
static ACCOUNT_CUED: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"(?i)\b(?:{ACCOUNT_CUES})\b\.?\s*(?:number|num|no\.?|nr\.?|\#|id)?\s*(?:is|:|=|\#)?\s*((?-i:[A-Z]{{1,4}})[\- ]?[0-9](?:[0-9\-]|\s[0-9]){{3,30}}|[0-9](?:[0-9\-]|\s[0-9]){{3,30}}(?-i:[A-Z])?|(?-i:[A-Z0-9]{{0,4}})[0-9](?-i:[A-Z0-9]){{3,20}})(?:$|[^\p{{L}}\p{{N}}])"
    ))
});
static SSN: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?:^|[^A-Za-z0-9_\-])([0-9]{3}-[0-9]{2}-[0-9]{4})(?:$|[^A-Za-z0-9_\-])"));
static YEAR: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:19|20)[0-9][0-9]$"));

static PHONE_INTL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?:^|[^A-Za-z0-9_+])(\+[0-9]{1,3}(?:[ .\-]?\([0-9]{1,4}\))?(?:[ .\-]?[0-9]{1,5}){2,5})(?:$|[^A-Za-z0-9_.\-]|[.\-](?:$|[^0-9]))",
    )
});
static PHONE_NANP_PAREN: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?:^|[^A-Za-z0-9_)])(\([0-9]{3}\) ?[0-9]{3}[ .\-][0-9]{4})(?:$|[^A-Za-z0-9_.\-]|[.\-](?:$|[^0-9]))")
});
static PHONE_NANP: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?:^|[^A-Za-z0-9_.\-/])([0-9]{3}\.[0-9]{3}\.[0-9]{4}|[0-9]{3}-[0-9]{3}-[0-9]{4})(?:$|[^A-Za-z0-9_.\-/]|[.\-/](?:$|[^0-9]))",
    )
});
static PHONE_NATIONAL: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?:^|[^A-Za-z0-9_.\-+/:])(0[0-9]{2,4}(?:[ /\-][0-9]{2,8}){1,3})(?:$|[^A-Za-z0-9_.\-/:]|[.\-/:](?:$|[^0-9]))")
});
static PHONE_NATIONAL_PLAIN: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?:^|[^A-Za-z0-9_.\-+/:])(0[1-9][0-9]{8,9})(?:$|[^A-Za-z0-9_.\-/:]|[.\-/:](?:$|[^0-9]))"));
static PHONE_CUED: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\b(?:phone|tel|telephone|mobile|mob|cell|cellphone|handy|telefon|telefonnummer|whatsapp|signal|fax|call\s+me\s+(?:at|on)|text\s+me\s+(?:at|on)|reach\s+me\s+(?:at|on))\b\.?\s*(?:number|no\.?|nr\.?|\#)?\s*[:=]?\s*(\+?\(?[0-9][0-9 ()./\-]{5,20}[0-9])(?:$|[^A-Za-z0-9_])",
    )
});
static DATE_LIKE: LazyLock<Regex> =
    LazyLock::new(|| re(r"\b[0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2}\b|\b[0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4}\b"));
static IP_LIKE: LazyLock<Regex> = LazyLock::new(|| re(r"^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$"));
static TIME_LIKE: LazyLock<Regex> = LazyLock::new(|| re(r"^[0-9]{1,2}[:.][0-9]{2}(?:[:.][0-9]{2})?$"));

const EN_STREETS: &str = "Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Parkway|Pkwy|Circle|Cir|Highway|Hwy|Square|Sq|Trail|Close|Crescent|Row|Mews|Gardens";
const CAP: &str = r"[\p{Lu}][\p{L}'’\-]*";
static ADDRESSES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        // 221B Baker Street, Apt 4, London / 1600 Pennsylvania Ave NW, Washington, DC 20500
        re(&format!(
            r"(?:^|[^A-Za-z0-9_.])([0-9]{{1,5}}[A-Za-z]?\s+(?:{CAP}\.?\s+){{1,4}}(?:{EN_STREETS})\b\.?(?:\s+(?:NW|NE|SW|SE|N|S|E|W)\b)?(?:,?\s*(?:Apt|Apartment|Suite|Ste|Unit|Flat|\#)\.?\s*[A-Za-z0-9\-]+)?(?:,\s*{CAP}(?:\s{CAP}){{0,2}}(?:,?\s*[A-Z]{{2}})?(?:\s+[0-9]{{5}}(?:-[0-9]{{4}})?)?)?)"
        )),
        // Hauptstraße 12a, 10115 Berlin
        re(&format!(
            r"(?:^|[^\p{{L}}])([\p{{Lu}}][\p{{L}}\-]*(?:straße|strasse|str\.|gasse|weg|allee|platz|damm|ufer|chaussee|pfad)\s*[0-9]{{1,3}}\s?[a-zA-Z]?\b(?:,?\s*[0-9]{{4,5}}\s+{CAP})?)"
        )),
        // Berliner Straße 5, Am Alten Weg 3
        re(&format!(
            r"(?:^|[^\p{{L}}])({CAP}\s+(?:Straße|Strasse|Str\.|Weg|Allee|Platz|Gasse|Ring|Damm|Ufer|Chaussee)\s+[0-9]{{1,3}}\s?[a-zA-Z]?\b(?:,?\s*[0-9]{{4,5}}\s+{CAP})?)"
        )),
        // 12 rue de la Paix, 75002 Paris
        re(&format!(
            r"(?:^|[^A-Za-z0-9_.])([0-9]{{1,4}}(?:\s?(?:bis|ter))?,?\s+(?:rue|avenue|boulevard|bd|chemin|place|impasse|allée|quai|route)\s+(?:(?:de|du|des|la|le|l['’]|d['’])\s*)*{CAP}(?:\s+{CAP}){{0,3}}(?:,?\s*[0-9]{{5}}\s+{CAP})?)"
        )),
        // Calle Mayor 5, Via Roma 10, Rua Augusta 274
        re(&format!(
            r"(\b(?:Calle|Avenida|Avda\.|Plaza|Paseo|Via|Viale|Piazza|Corso|Rua|Travessa)\s+(?:(?:de|del|la|las|los|dei|della|di|do|da|dos)\s+)*{CAP}(?:\s+{CAP}){{0,3}},?\s*(?:n[º°o]\.?\s*)?[0-9]{{1,4}}\b)"
        )),
    ]
});

const NAME: &str = r"[\p{Lu}][\p{Ll}'’\-]*(?:[\p{Lu}][\p{Ll}'’\-]+)?";
static FULL_NAME: LazyLock<String> = LazyLock::new(|| {
    format!(r"{NAME}(?:\s+(?:(?:van|von|de|der|den|da|di|du|la|le|del|bin|al|ten|ter)\s+)*{NAME}){{0,2}}")
});
static HONORIFIC: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"\b(?:Mr|Mrs|Ms|Mx|Miss|Dr|Prof|Sir|Dame|Herr|Frau|Mme|Mlle|Sr|Sra|Srta|Signor|Signora|Dott)\.?\s+({})",
        *FULL_NAME
    ))
});
static RELATION: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"(?i:\b(?:my|our|his|her|their|mein(?:e|em|en)?|unser(?:e|em|en)?)\s+(?:wife|husband|partner|girlfriend|boyfriend|fianc[eé]e?|son|daughter|mother|mom|mum|father|dad|brother|sister|friend|best\s+friend|boss|manager|colleague|coworker|co-worker|neighbou?r|doctor|dentist|therapist|lawyer|landlord|landlady|cousin|uncle|aunt|grandma|grandpa|grandmother|grandfather|niece|nephew|kid|child|baby|ex|roommate|flatmate|teacher|tutor|frau|mann|freund|freundin|tochter|sohn|mutter|vater|bruder|schwester|chef|chefin|kollege|kollegin|nachbar|nachbarin|oma|opa)\s*,?\s+)({})",
        *FULL_NAME
    ))
});
static NAMED: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"(?i:\b(?:named|called|name\s+is|name's|heißt|heisst|ich\s+heiße|mein\s+name\s+ist|je\s+m'appelle|me\s+llamo|mi\s+chiamo)\s+)({})",
        *FULL_NAME
    ))
});
static SELF: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"(?i:\b(?:I\s+am|I'm|I’m|this\s+is|ich\s+bin)\s+)({NAME}(?:\s+{NAME})?)")));
static GREETING: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"(?m)^\s*(?:Hi|Hello|Hey|Dear|Hallo|Liebe|Lieber|Moin|Servus|Bonjour|Salut|Hola|Ciao|Olá)\s+({})\s*(?:[,!]|$)",
        *FULL_NAME
    ))
});
static SIGN_OFF: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"(?im)^\s*(?:best|regards|best\s+regards|kind\s+regards|warm\s+regards|cheers|thanks|thank\s+you|many\s+thanks|sincerely|yours|love|viele\s+grüße|liebe\s+grüße|beste\s+grüße|grüße|lg|vg|mfg|mit\s+freundlichen\s+grüßen|cordialement|bisous|saludos|un\s+saludo|cordiali\s+saluti)\s*[,!.]?\s*\n\s*((?-i:{}))\s*$",
        *FULL_NAME
    ))
});
static CAPITALISED: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?:^|[^\p{L}\p{N}_@./\-])([\p{Lu}][\p{Ll}]+(?:['’\-][\p{L}]+)?)(?:$|[^\p{L}\p{N}_@.]|\.(?:$|[^\p{L}]))")
});
static WORD_AT: LazyLock<Regex> = LazyLock::new(|| re(r"^[\p{L}][\p{L}'’\-]*"));

static FENCE: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)```.*?(?:```|\z)|~~~.*?(?:~~~|\z)"));
static INLINE_CODE: LazyLock<Regex> = LazyLock::new(|| re(r"`[^`\n]+`"));
static LINK: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(?i)\b(?:https?|ftp|file|wss?)://[^\s<>"'`)\]]+|\bwww\.[^\s<>"'`)\]]+"#));
static PLACEHOLDER: LazyLock<Regex> =
    LazyLock::new(|| re(r"(\[|%5[Bb])(PERSON|EMAIL|PHONE|ADDRESS|CARD|IBAN|ACCOUNT)_([0-9]{1,5})(?:\]|%5[Dd])"));
static DIGIT_RUN: LazyLock<Regex> = LazyLock::new(|| re(r"\+?[0-9](?:[ \-./]?[0-9])*"));

fn words(list: &'static str) -> HashSet<&'static str> {
    list.split_whitespace().collect()
}

const FILE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "svg", "webp", "pdf", "heic", "ico", "bmp"];
const SERVICE_LOCALS: &[&str] =
    &["git", "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon", "postmaster"];
const EXAMPLE_DOMAINS: &[&str] = &["example.com", "example.org", "example.net", "example.edu", "example"];

static HONORIFICS: LazyLock<HashSet<&str>> =
    LazyLock::new(|| words("mr mrs ms mx miss dr prof sir dame herr frau mme mlle sr sra srta signor signora dott"));
static PARTICLES: LazyLock<HashSet<&str>> =
    LazyLock::new(|| words("van von de der den da di du la le del bin al ten ter"));
/// Capitalised words that are not names (sentence furniture, calendar, roles, places in prose).
static NOT_NAMES: LazyLock<HashSet<&str>> = LazyLock::new(|| {
    words(
        "the a an and or but if so to of in on at by for with from as is are was be it its this that these those there \
         here then than when where what which who why how while will would should could can may might have has had not \
         no yes ok okay all any each every some many most more much very only just even also after before about above \
         below because please thanks thank hello hi hey dear team everyone folks guys sir madam user users you your yours \
         we our they their he she him her his my me monday tuesday wednesday thursday friday saturday sunday january \
         february march april may june july august september october november december today tomorrow yesterday morning \
         evening night week weekend month year note notes todo done none true false null sorry sure great good fine \
         important best regards cheers street road avenue lane city town doctor manager admin support customer client \
         service account bank card phone email address name password project meeting hallo liebe lieber herr frau danke \
         bitte und oder der die das ein eine ich du sie wir ihr mein dein heute morgen gestern",
    )
});
/// Words that follow a first name but are not surnames ("Max Tokens", "Grace Period").
static SURNAME_BLOCK: LazyLock<HashSet<&str>> = LazyLock::new(|| {
    words(
        "tokens token period size value mode level street road avenue lane drive way university college school hospital \
         bank group inc ltd gmbh corp foundation park hotel airport station church museum river lake mountain island bay \
         city county state day week month year studio pro max mini plus ultra lite edition",
    )
});
/// First names that are also common words: they count only with a surname or a cue.
static AMBIGUOUS_FIRST_NAMES: LazyLock<HashSet<&str>> = LazyLock::new(|| {
    words(
        "will may june april august mark bill grace hope joy faith rose summer art max jack frank sue pat rob jean ken don \
         ray dawn iris amber ruby jade crystal chase hunter jordan paris georgia florence eve carol dean drew gene guy \
         miles penny sky angel rich victor lily violet olive ivy page harmony sage river storm august christian ali major \
         earl duke king prince noble mason cash bishop ginger holly heather autumn winter melody precious sandy misty lee \
         nova luna stella aurora eden zion jan min jun li saga mercedes austin virginia victoria madison julia sunita page \
         ren aoi",
    )
});
/// Common first names (lower case) across the languages Autobot is used in.
static FIRST_NAMES: LazyLock<HashSet<&str>> = LazyLock::new(|| {
    words(
        "james john robert michael william david richard joseph thomas charles christopher daniel matthew anthony mark \
         donald steven paul andrew joshua kenneth kevin brian george timothy ronald edward jason jeffrey ryan jacob gary \
         nicholas eric jonathan stephen larry justin scott brandon benjamin samuel gregory alexander patrick frank \
         raymond jack dennis jerry tyler aaron jose adam nathan henry douglas zachary peter kyle noah ethan jeremy \
         walter christian keith roger terry austin sean gerald carl harold dylan arthur lawrence jordan jesse bryan \
         billy bruce gabriel joe logan alan juan albert willie elijah wayne randy vincent mason roy ralph bobby russell \
         bradley philip eugene oliver liam lucas leo oscar hugo felix theo elias jonas finn luca luis carlos miguel \
         mary patricia jennifer linda elizabeth barbara susan jessica sarah karen lisa nancy betty sandra margaret ashley \
         kimberly emily donna michelle carol amanda melissa deborah stephanie dorothy rebecca sharon laura cynthia amy \
         kathleen angela shirley brenda emma anna pamela nicole samantha katherine christine helen debra rachel carolyn \
         janet maria catherine heather diane olivia julie joyce victoria ruth virginia lauren kelly christina joan evelyn \
         judith andrea hannah megan cheryl jacqueline martha madison teresa gloria sara janice ann kathryn abigail sophia \
         frances jean alice judy isabella julia grace amber denise danielle marilyn beverly charlotte natalie theresa \
         diana brittany doris kayla alexis lori marie mia ava ella chloe zoe lily nora clara alina elena sofia lena \
         lea leonie lara laura johanna paula marlene greta ida frieda mathilda emilia luisa marie sophie charlotte \
         lukas leon paul ben jonas elias noah finn luis felix maximilian julian moritz niklas tim jan tom philipp \
         sebastian florian tobias stefan andreas markus matthias christian michael thomas daniel alexander martin jens \
         ludwig uwe jürgen klaus wolfgang dieter manfred helmut horst bernd frank torsten sven jörg ralf heike sabine petra \
         monika ursula renate birgit claudia susanne andrea stefanie katrin nadine anja silke tanja kerstin ute \
         jean pierre jacques louis antoine nicolas camille julien mathieu guillaume baptiste léa manon chloé inès \
         jade louise juliette margaux céline aurélie mathilde amélie élodie marion océane \
         alejandro javier pablo diego sergio manuel antonio francisco jorge alberto fernando raúl lucía carmen isabel \
         pilar rosa dolores mercedes francesca giulia chiara giorgia martina alessia marco giuseppe giovanni francesco \
         alessandro matteo lorenzo andrea davide simone federico riccardo stefano \
         joão pedro tiago rafael bruno beatriz mariana inês ana catarina \
         sven lars erik nils anders magnus johan karl olaf astrid ingrid sigrid freya maja elsa linnea saga \
         jan piet kees joost daan bram sanne femke lotte anouk \
         ivan dmitri sergei alexei mikhail nikolai olga natasha tatiana svetlana irina ekaterina anastasia \
         piotr tomasz krzysztof agnieszka katarzyna magdalena \
         mohammed muhammad ahmed ali omar hassan hussein khalid youssef ibrahim fatima aisha layla zainab mariam \
         yusuf mehmet mustafa emre elif zeynep ayşe \
         raj rahul amit vikram arjun rohan priya ananya divya kavya pooja neha deepa sunita \
         wei li ming jun hao yan mei ling xin yuki haruto sota yuto hina sakura aoi ren min seo jiho \
         kwame kofi amara chidi ngozi tunde",
    )
});

const IBAN_LENGTHS: &str = "AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DK18 \
    DO28 EE20 EG29 ES24 FI18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 \
    LB28 LC32 LI21 LT20 LU20 LV21 MC27 MD24 ME22 MK19 MR27 MT31 MU30 NL18 NO15 PK24 PL28 PS29 PT25 QA29 RO24 RS22 SA24 \
    SC31 SE24 SI19 SK24 SM27 ST25 SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20";

fn iban_length(country: &str) -> Option<usize> {
    IBAN_LENGTHS.split_whitespace().find(|e| &e[..2] == country).and_then(|e| e[2..].parse().ok())
}

// ---------------------------------------------------------------------------------------------
// Detection

/// The cores of [re]'s matches (group 1), scanning on after each core.
fn cores(re: &Regex, text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut at = 0;
    while at <= text.len() {
        let Some(caps) = re.captures_at(text, at) else { break };
        let core = caps.get(1).expect("group 1");
        out.push((core.start(), core.end()));
        at = if core.end() > at { core.end() } else { at + 1 };
        while at < text.len() && !text.is_char_boundary(at) {
            at += 1;
        }
    }
    out
}

fn luhn(digits: &str) -> bool {
    let mut sum = 0;
    for (i, c) in digits.bytes().rev().enumerate() {
        let mut d = u32::from(c - b'0');
        if i % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    digits.len() >= 2 && sum % 10 == 0
}

fn iban_valid(compact: &str) -> bool {
    let Some(length) = compact.get(..2).and_then(iban_length) else { return false };
    let b = compact.as_bytes();
    if compact.len() != length
        || !b.iter().all(u8::is_ascii_alphanumeric)
        || !b[2].is_ascii_digit()
        || !b[3].is_ascii_digit()
    {
        return false;
    }
    let moved = format!("{}{}", &compact[4..], &compact[..4]);
    let mut rem: u32 = 0;
    for c in moved.bytes() {
        rem = if c.is_ascii_digit() {
            (rem * 10 + u32::from(c - b'0')) % 97
        } else {
            (rem * 100 + u32::from(c.to_ascii_uppercase() - b'A' + 10)) % 97
        };
    }
    rem == 1
}

/// Code (fenced blocks, inline code) and links in a text.
struct Guards {
    code: Vec<(usize, usize)>,
    links: Vec<(usize, usize)>,
}

impl Guards {
    fn new(text: &str) -> Self {
        let mut code: Vec<(usize, usize)> = FENCE.find_iter(text).map(|m| (m.start(), m.end())).collect();
        for m in INLINE_CODE.find_iter(text) {
            if !code.iter().any(|&(s, e)| m.start() >= s && m.start() < e) {
                code.push((m.start(), m.end()));
            }
        }
        Self { code, links: LINK.find_iter(text).map(|m| (m.start(), m.end())).collect() }
    }

    fn in_code(&self, s: usize, e: usize) -> bool {
        self.code.iter().any(|&(a, b)| s < b && a < e)
    }

    fn blocked(&self, s: usize, e: usize) -> bool {
        self.in_code(s, e) || self.links.iter().any(|&(a, b)| s < b && a < e)
    }
}

struct Candidate {
    start: usize,
    end: usize,
    kind: Kind,
    priority: u8,
}

/// Collects candidates, trimmed of leading whitespace and trailing whitespace and commas.
struct Found<'t> {
    text: &'t str,
    list: Vec<Candidate>,
}

impl Found<'_> {
    fn add(&mut self, start: usize, end: usize, kind: Kind, priority: u8) {
        let s = &self.text[start..end];
        let lead = s.len() - s.trim_start().len();
        let trimmed = s.trim_end_matches(|c: char| c.is_whitespace() || c == ',');
        if trimmed.len() > lead {
            self.list.push(Candidate { start: start + lead, end: start + trimmed.len(), kind, priority });
        }
    }
}

/// Personal data in [text], non-overlapping, in order.
pub fn detect(text: &str) -> Vec<Span> {
    if text.is_empty() {
        return Vec::new();
    }
    let guards = Guards::new(text);
    let mut found = Found { text, list: Vec::new() };
    emails(text, &mut found);
    ibans(text, &mut found);
    cards(text, &guards, &mut found);
    accounts(text, &guards, &mut found);
    phones(text, &guards, &mut found);
    addresses(text, &guards, &mut found);
    people(text, &guards, &mut found);

    // The most reliable first, then the longest, then the earliest; keep what does not overlap.
    let mut list = found.list;
    list.sort_by_key(|c| (c.priority, std::cmp::Reverse(c.end - c.start), c.start));
    let mut taken: Vec<Candidate> = Vec::new();
    for c in list {
        if !taken.iter().any(|t| c.start < t.end && t.start < c.end) {
            taken.push(c);
        }
    }
    taken.sort_by_key(|c| c.start);
    taken.into_iter().map(|c| Span { start: c.start, end: c.end, kind: c.kind }).collect()
}

fn emails(text: &str, out: &mut Found) {
    for (s, e) in cores(&EMAIL, text) {
        let value = text[s..e].to_lowercase();
        let (local, domain) = value.split_once('@').expect("an @");
        let tld = domain.rsplit('.').next().unwrap_or("");
        let example = EXAMPLE_DOMAINS.iter().any(|d| domain == *d || domain.ends_with(&format!(".{d}")));
        let reserved = [".invalid", ".test", ".localhost"].iter().any(|t| domain.ends_with(t));
        if FILE_EXTENSIONS.contains(&tld) || SERVICE_LOCALS.contains(&local) || example || reserved {
            continue;
        }
        out.add(s, e, Kind::Email, P_EMAIL);
    }
}

fn ibans(text: &str, out: &mut Found) {
    for (s, e) in cores(&IBAN, text) {
        let Some(length) = iban_length(&text[s..s + 2]) else { continue };
        let mut count = 0;
        let mut cut = None;
        let mut compact = String::new();
        for (i, c) in text[s..e].char_indices() {
            if c == ' ' {
                continue;
            }
            compact.push(c);
            count += 1;
            if count == length {
                cut = Some(s + i + c.len_utf8());
                break;
            }
        }
        let Some(cut) = cut else { continue };
        if text[cut..].chars().next().is_some_and(char::is_alphanumeric) {
            continue;
        }
        if iban_valid(&compact) {
            out.add(s, cut, Kind::Iban, P_IBAN);
        }
    }
}

fn cards(text: &str, guards: &Guards, out: &mut Found) {
    for (s, e) in cores(&CARD, text) {
        if guards.blocked(s, e) {
            continue;
        }
        let digits: String = text[s..e].chars().filter(char::is_ascii_digit).collect();
        let first = digits.as_bytes()[0];
        if !(13..=19).contains(&digits.len()) || !(b'2'..=b'6').contains(&first) || digits.bytes().all(|d| d == first) {
            continue;
        }
        if luhn(&digits) {
            out.add(s, e, Kind::Card, P_CARD);
        }
    }
}

fn accounts(text: &str, guards: &Guards, out: &mut Found) {
    for (s, e) in cores(&ACCOUNT_CUED, text) {
        if guards.in_code(s, e) {
            continue;
        }
        let value = &text[s..e];
        let digits = value.chars().filter(char::is_ascii_digit).count();
        if digits < 4 || (digits == 4 && value.len() == 4 && YEAR.is_match(value)) {
            continue;
        }
        out.add(s, e, Kind::Account, P_ACCOUNT);
    }
    for (s, e) in cores(&SSN, text) {
        if !guards.blocked(s, e) {
            out.add(s, e, Kind::Account, P_ACCOUNT);
        }
    }
}

fn phones(text: &str, guards: &Guards, out: &mut Found) {
    let patterns: [(&Regex, usize, usize, u8); 6] = [
        (&PHONE_INTL, 8, 15, P_PHONE),
        (&PHONE_NANP_PAREN, 10, 10, P_PHONE),
        (&PHONE_NANP, 10, 10, P_PHONE),
        (&PHONE_NATIONAL, 9, 12, P_PHONE),
        (&PHONE_NATIONAL_PLAIN, 10, 11, P_PHONE),
        (&PHONE_CUED, 7, 15, P_PHONE_CUED),
    ];
    for (pattern, min, max, priority) in patterns {
        for (s, e) in cores(pattern, text) {
            if guards.blocked(s, e) {
                continue;
            }
            let value = &text[s..e];
            let digits = value.chars().filter(char::is_ascii_digit).count();
            if !(min..=max).contains(&digits)
                || DATE_LIKE.is_match(value)
                || IP_LIKE.is_match(value.trim())
                || TIME_LIKE.is_match(value.trim())
            {
                continue;
            }
            out.add(s, e, Kind::Phone, priority);
        }
    }
}

fn addresses(text: &str, guards: &Guards, out: &mut Found) {
    for pattern in ADDRESSES.iter() {
        for (s, e) in cores(pattern, text) {
            if !guards.blocked(s, e) {
                out.add(s, e, Kind::Address, P_ADDRESS);
            }
        }
    }
}

fn people(text: &str, guards: &Guards, out: &mut Found) {
    let skippable = |word: &str| {
        let lower = word.to_lowercase();
        let lower = lower.trim_end_matches('.');
        NOT_NAMES.contains(lower) || HONORIFICS.contains(lower)
    };
    let mut name = |start: usize, mut end: usize, priority: u8| {
        if start >= end {
            return;
        }
        // A possessive belongs to the sentence, not the name.
        let value = &text[start..end];
        if value.chars().count() > 2 {
            if value.ends_with("'s") {
                end -= 2;
            } else if value.ends_with("’s") {
                end -= "’s".len();
            }
        }
        if guards.blocked(start, end) {
            return;
        }
        let value = &text[start..end];
        let words: Vec<&str> = value.split([' ', '\n', '\t']).filter(|w| !w.is_empty()).collect();
        if words.is_empty() || words.iter().all(|w| skippable(w) || PARTICLES.contains(w.to_lowercase().as_str())) {
            return;
        }
        // "Dear Ms Abernathy", "Hi Team Lead": the name starts after honorifics and furniture.
        let mut start = start;
        for word in &words {
            if !skippable(word) {
                break;
            }
            start = text[start..].find(word).map_or(end, |i| start + i + word.len());
            while start < end && text[start..].starts_with(char::is_whitespace) {
                start += text[start..].chars().next().map_or(1, char::len_utf8);
            }
        }
        if start >= end {
            return;
        }
        out.add(start, end, Kind::Person, priority);
    };
    for pattern in [&*HONORIFIC, &*RELATION, &*NAMED, &*GREETING, &*SIGN_OFF] {
        for caps in pattern.captures_iter(text) {
            if let Some(g) = caps.get(1) {
                name(g.start(), g.end(), P_NAME_CUED);
            }
        }
    }
    for caps in SELF.captures_iter(text) {
        let Some(g) = caps.get(1) else { continue };
        let words: Vec<&str> = g.as_str().split(' ').collect();
        // "I'm Hannah", "this is Lea Wolf"; not "I'm Sorry" or "this is Important".
        if words.len() >= 2 || FIRST_NAMES.contains(words[0].to_lowercase().as_str()) {
            name(g.start(), g.end(), P_NAME_CUED);
        }
    }
    // First names from the list, with the surname that follows.
    for (s, e) in cores(&CAPITALISED, text) {
        let lower = text[s..e].to_lowercase();
        let lower = lower.strip_suffix("'s").or_else(|| lower.strip_suffix("’s")).unwrap_or(&lower);
        if !FIRST_NAMES.contains(lower) {
            continue;
        }
        let surname = surname_after(text, e);
        if surname.is_none() && AMBIGUOUS_FIRST_NAMES.contains(lower) {
            continue;
        }
        name(s, surname.unwrap_or(e), P_NAME_LIST);
    }
}

/// End of a surname (with particles: "van der Berg") right after a first name ending at [at].
fn surname_after(text: &str, at: usize) -> Option<usize> {
    let mut i = at;
    let mut end = None;
    for _ in 0..4 {
        if !text[i..].starts_with(' ') {
            break;
        }
        let Some(m) = WORD_AT.find(&text[i + 1..]) else { break };
        let word = m.as_str();
        let lower = word.to_lowercase();
        if PARTICLES.contains(lower.as_str()) {
            i = i + 1 + m.end();
            continue;
        }
        let first_upper = word.chars().next().is_some_and(char::is_uppercase);
        if !first_upper
            || word.chars().count() < 2
            || NOT_NAMES.contains(lower.as_str())
            || SURNAME_BLOCK.contains(lower.as_str())
            || word.chars().all(char::is_uppercase)
        {
            break;
        }
        end = Some(i + 1 + m.end());
        break;
    }
    end
}

// ---------------------------------------------------------------------------------------------
// The vault

const MIN_TERM: usize = 3;
const MAX_TERM: usize = 120;
const MIN_DIGITS: usize = 4;

/// [literal]: placeholder-shaped text the user wrote themselves ("[PERSON_1]").
struct Entry {
    kind: Kind,
    value: String,
    placeholder: Option<String>,
    digits: Option<String>,
    forms: Vec<String>,
    literal: bool,
}

/// The placeholders of one request, as Autobot's `RedactionVault`: each personal value gets a
/// stable placeholder the first time it is seen, and every later occurrence of it (in any form)
/// is replaced too.
#[derive(Default)]
pub struct Vault {
    entries: Vec<(String, Entry)>,
    index: HashMap<String, usize>,
    by_placeholder: HashMap<String, usize>,
    counters: [u32; 7],
}

fn key(kind: Kind, value: &str) -> String {
    let no_letters = !value.chars().any(char::is_alphabetic);
    match kind {
        Kind::Email => format!("e:{}", value.to_lowercase()),
        Kind::Iban => format!("i:{}", value.chars().filter(|c| *c != ' ').collect::<String>().to_uppercase()),
        _ if kind.numeric() && no_letters && value.chars().any(|c| c.is_ascii_digit()) => {
            format!("d:{}", value.chars().filter(char::is_ascii_digit).collect::<String>())
        }
        _ => format!("w:{value}"),
    }
}

fn digits_of(kind: Kind, value: &str) -> Option<String> {
    let digits: String = value.chars().filter(char::is_ascii_digit).collect();
    (kind.numeric() && !value.chars().any(char::is_alphabetic) && digits.len() >= MIN_DIGITS).then_some(digits)
}

/// Not part of a longer word or number.
fn bounded(text: &str, start: usize, end: usize) -> bool {
    let before = text[..start].chars().next_back().unwrap_or(' ');
    let after = text[end..].chars().next().unwrap_or(' ');
    !before.is_alphanumeric() && before != '_' && !after.is_alphanumeric() && after != '_'
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the values.
        write!(f, "Vault({:?})", self.found())
    }
}

impl Vault {
    fn insert(&mut self, k: String, entry: Entry) -> usize {
        let i = self.entries.len();
        if let Some(p) = &entry.placeholder {
            self.by_placeholder.insert(p.clone(), i);
        }
        self.index.insert(k.clone(), i);
        self.entries.push((k, entry));
        i
    }

    fn number(&mut self, i: usize) {
        let kind = self.entries[i].1.kind;
        self.counters[kind.index()] += 1;
        let placeholder = format!("[{}_{}]", kind.tag(), self.counters[kind.index()]);
        self.by_placeholder.insert(placeholder.clone(), i);
        self.entries[i].1.placeholder = Some(placeholder);
    }

    /// Placeholder-shaped text in the input. Its number is never handed out; when it already names
    /// a value, the text gets a placeholder of its own so the model can tell the two apart.
    /// Percent-encoded ones only reserve their number.
    fn literal(&mut self, open: &str, tag: &str, n: &str) {
        let (Some(kind), Ok(n)) = (Kind::parse(tag), n.parse::<u32>()) else { return };
        let bracket = format!("[{}_{n}]", kind.tag());
        let owner = self.by_placeholder.get(&bracket).copied();
        if owner.is_none() && self.counters[kind.index()] < n {
            self.counters[kind.index()] = n;
        }
        if open != "[" {
            return;
        }
        let k = format!("l:{bracket}");
        if self.index.contains_key(&k) {
            return;
        }
        let entry = |placeholder| Entry {
            kind,
            value: bracket.clone(),
            placeholder,
            digits: None,
            forms: vec![bracket.clone()],
            literal: true,
        };
        match owner {
            // Kept as written: it stands for itself.
            None => {
                self.insert(k, entry(Some(bracket.clone())));
            }
            Some(o) if !self.entries[o].1.literal => {
                let i = self.insert(k, entry(None));
                self.number(i);
            }
            Some(_) => {}
        }
    }

    fn register(&mut self, kind: Kind, value: &str) {
        let k = key(kind, value);
        if let Some(&i) = self.index.get(&k) {
            if !self.entries[i].1.forms.iter().any(|f| f == value) {
                self.entries[i].1.forms.push(value.to_owned());
            }
            if self.entries[i].1.placeholder.is_none() {
                self.number(i);
            }
            return;
        }
        let i = self.insert(
            k,
            Entry {
                kind,
                value: value.to_owned(),
                placeholder: None,
                digits: digits_of(kind, value),
                forms: vec![value.to_owned()],
                literal: false,
            },
        );
        self.number(i);
        // The parts of a full name get their own placeholders when they appear alone.
        if kind == Kind::Person {
            let parts: Vec<&str> = value
                .split(' ')
                .filter(|p| {
                    p.chars().count() >= 3
                        && p.chars().next().is_some_and(char::is_uppercase)
                        && !NOT_NAMES.contains(p.to_lowercase().as_str())
                })
                .collect();
            if parts.len() > 1 {
                for part in parts {
                    self.candidate(kind, part);
                }
            }
        }
    }

    fn candidate(&mut self, kind: Kind, raw: &str) {
        let value = raw.trim();
        if !(MIN_TERM..=MAX_TERM).contains(&value.chars().count()) {
            return;
        }
        let k = key(kind, value);
        if self.index.contains_key(&k) {
            return;
        }
        self.insert(
            k,
            Entry {
                kind,
                value: value.to_owned(),
                placeholder: None,
                digits: digits_of(kind, value),
                forms: vec![value.to_owned()],
                literal: false,
            },
        );
    }

    /// [text] with its personal data replaced.
    pub fn redact(&mut self, text: &str) -> String {
        if text.trim().is_empty() {
            return text.to_owned();
        }
        let spans = detect(text);
        // Placeholder-shaped text the user wrote comes first: its numbers are never handed out.
        let literals: Vec<(String, String, String)> =
            PLACEHOLDER.captures_iter(text).map(|c| (c[1].to_owned(), c[2].to_owned(), c[3].to_owned())).collect();
        for (open, tag, n) in &literals {
            self.literal(open, tag, n);
        }
        for span in spans {
            self.register(span.kind, &text[span.start..span.end]);
        }
        self.replace(text)
    }

    /// Replaces every occurrence of a known value (longest first, no overlaps).
    fn replace(&mut self, text: &str) -> String {
        let guards = Guards::new(text);
        let mut hits: Vec<(usize, usize, usize)> = Vec::new();
        for (i, (_, e)) in self.entries.iter().enumerate() {
            for form in &e.forms {
                let found: Vec<(usize, usize)> = if e.kind == Kind::Email {
                    let pattern =
                        RegexBuilder::new(&regex::escape(form)).case_insensitive(true).build().expect("escaped");
                    pattern.find_iter(text).map(|m| (m.start(), m.end())).collect()
                } else {
                    text.match_indices(form.as_str()).map(|(at, f)| (at, at + f.len())).collect()
                };
                for (start, end) in found {
                    // A literal placeholder is bracketed: it counts wherever it is written.
                    if e.literal {
                        hits.push((start, end, i));
                        continue;
                    }
                    if !bounded(text, start, end) || (e.kind.wordy() && guards.blocked(start, end)) {
                        continue;
                    }
                    hits.push((start, end, i));
                }
            }
        }
        // The same number written differently ("+49 171 2345678" / "+49 1712345678").
        let by_digits: HashMap<&str, usize> =
            self.entries.iter().enumerate().filter_map(|(i, (_, e))| e.digits.as_deref().map(|d| (d, i))).collect();
        if !by_digits.is_empty() {
            for m in DIGIT_RUN.find_iter(text) {
                let digits: String = m.as_str().chars().filter(char::is_ascii_digit).collect();
                if let Some(&i) = by_digits.get(digits.as_str())
                    && bounded(text, m.start(), m.end())
                {
                    hits.push((m.start(), m.end(), i));
                }
            }
        }
        if hits.is_empty() {
            return text.to_owned();
        }
        hits.sort_by_key(|&(start, end, _)| (start, std::cmp::Reverse(end)));
        let mut out = String::with_capacity(text.len());
        let mut cursor = 0;
        for (start, end, i) in hits {
            if start < cursor {
                continue;
            }
            if self.entries[i].1.placeholder.is_none() {
                self.number(i);
            }
            out.push_str(&text[cursor..start]);
            out.push_str(self.entries[i].1.placeholder.as_deref().expect("numbered"));
            cursor = end;
        }
        out.push_str(&text[cursor..]);
        out
    }

    /// [text] with this vault's placeholders turned back into their values (unknown ones stay).
    pub fn restore(&self, text: &str) -> String {
        if self.by_placeholder.is_empty() || (!text.contains('[') && !text.contains('%')) {
            return text.to_owned();
        }
        PLACEHOLDER
            .replace_all(text, |caps: &regex::Captures| {
                let bracket = format!("[{}_{}]", &caps[2], &caps[3]);
                match self.by_placeholder.get(&bracket) {
                    Some(&i) if &caps[1] == "[" => self.entries[i].1.value.clone(),
                    Some(&i) => percent_encode(&self.entries[i].1.value),
                    None => caps[0].to_owned(),
                }
            })
            .into_owned()
    }

    /// Distinct personal values hidden, per kind tag.
    pub fn found(&self) -> BTreeMap<&'static str, usize> {
        let mut found = BTreeMap::new();
        for (_, e) in &self.entries {
            if !e.literal && e.placeholder.is_some() {
                *found.entry(e.kind.tag()).or_insert(0) += 1;
            }
        }
        found
    }

    pub fn is_empty(&self) -> bool {
        self.found().is_empty()
    }
}

// ---------------------------------------------------------------------------------------------
// Requests and answers

/// The texts of a chat completion request that redaction covers, in order.
fn request_texts(body: &mut Value) -> Vec<&mut String> {
    let mut texts = Vec::new();
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else { return texts };
    for message in messages {
        let Some(message) = message.as_object_mut() else { continue };
        for (field, value) in message.iter_mut() {
            match (field.as_str(), value) {
                ("tool_calls", Value::Array(calls)) => {
                    for call in calls {
                        if let Some(Value::String(args)) = call.pointer_mut("/function/arguments") {
                            texts.push(args);
                        }
                    }
                }
                ("content", Value::String(s)) => texts.push(s),
                ("content", Value::Array(parts)) => {
                    for part in parts {
                        if let Some(Value::String(s)) = part.get_mut("text") {
                            texts.push(s);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    texts
}

/// Redacts a chat completion request in place; the vault restores the answer.
pub fn redact_request(body: &mut Value) -> Vault {
    let mut vault = Vault::default();
    for text in request_texts(body) {
        *text = vault.redact(text);
    }
    vault
}

/// Restores a whole (non-streamed) chat completion response in place.
pub fn restore_response(vault: &Vault, body: &mut Value) {
    let Some(choices) = body.get_mut("choices").and_then(Value::as_array_mut) else { return };
    for choice in choices {
        if let Some(Value::String(s)) = choice.pointer_mut("/message/content") {
            *s = vault.restore(s);
        }
        if let Some(calls) = choice.pointer_mut("/message/tool_calls").and_then(Value::as_array_mut) {
            for call in calls {
                if let Some(Value::String(args)) = call.pointer_mut("/function/arguments") {
                    *args = vault.restore(args);
                }
            }
        }
    }
}

/// Restores streamed (SSE) chat completion chunks. A placeholder split across chunks is held back
/// until it is whole or its choice finishes.
pub struct StreamRestorer {
    vault: Vault,
    line: Vec<u8>,
    carry: BTreeMap<u64, String>,
}

/// The longest tail of [text] that could still grow into a placeholder (`[`, `[EMA`, `[EMAIL_1`).
fn open_tail(text: &str) -> usize {
    let Some(i) = text.rfind('[') else { return 0 };
    let tail = &text[i + 1..];
    let could_grow = tail.len() <= 13
        && match tail.find('_') {
            None => tail.bytes().all(|b| b.is_ascii_uppercase()) && KINDS.iter().any(|k| k.tag().starts_with(tail)),
            Some(u) => Kind::parse(&tail[..u]).is_some() && tail[u + 1..].bytes().all(|b| b.is_ascii_digit()),
        };
    if could_grow { text.len() - i } else { 0 }
}

impl StreamRestorer {
    pub fn new(vault: Vault) -> Self {
        Self { vault, line: Vec::new(), carry: BTreeMap::new() }
    }

    /// Feeds bytes from the upstream stream; returns the bytes to send on.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for &b in bytes {
            self.line.push(b);
            if b == b'\n' {
                let line = std::mem::take(&mut self.line);
                out.extend(self.line_out(&line));
            }
        }
        out
    }

    /// The end of the upstream stream: whatever is still held back.
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        if !self.line.is_empty() {
            let line = std::mem::take(&mut self.line);
            out.extend(self.line_out(&line));
        }
        out.extend(self.flush_all());
        out
    }

    fn flush_all(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        for (index, text) in std::mem::take(&mut self.carry) {
            if !text.is_empty() {
                let chunk = serde_json::json!({ "choices": [{ "index": index, "delta": { "content": self.vault.restore(&text) } }] });
                out.extend(format!("data: {chunk}\n\n").into_bytes());
            }
        }
        out
    }

    fn line_out(&mut self, line: &[u8]) -> Vec<u8> {
        let Ok(text) = std::str::from_utf8(line) else { return line.to_vec() };
        let Some(data) = text.strip_prefix("data:") else { return line.to_vec() };
        let data = data.trim();
        if data == "[DONE]" {
            let mut out = self.flush_all();
            out.extend_from_slice(line);
            return out;
        }
        let Ok(mut chunk) = serde_json::from_str::<Value>(data) else { return line.to_vec() };
        if let Some(choices) = chunk.get_mut("choices").and_then(Value::as_array_mut) {
            for choice in choices {
                let index = choice.get("index").and_then(Value::as_u64).unwrap_or(0);
                let finished = choice.get("finish_reason").is_some_and(|f| !f.is_null());
                let held = self.carry.remove(&index).unwrap_or_default();
                let delta = choice.pointer_mut("/delta/content");
                let mut text = held;
                if let Some(Value::String(s)) = &delta {
                    text.push_str(s);
                }
                let keep = if finished { 0 } else { open_tail(&text) };
                let (send, hold) = text.split_at(text.len() - keep);
                if !hold.is_empty() {
                    self.carry.insert(index, hold.to_owned());
                }
                let restored = self.vault.restore(send);
                match delta {
                    Some(slot) => *slot = Value::String(restored),
                    None if !restored.is_empty() => {
                        if let Some(obj) = choice.as_object_mut() {
                            let d = obj.entry("delta").or_insert_with(|| serde_json::json!({}));
                            if let Some(d) = d.as_object_mut() {
                                d.insert("content".into(), Value::String(restored));
                            }
                        }
                    }
                    None => {}
                }
            }
        }
        format!("data: {chunk}\n").into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::{StreamRestorer, Vault, open_tail, redact_request, restore_response};
    use serde_json::json;

    #[test]
    fn every_pattern_compiles() {
        // Forces each lazily built pattern; a typo would otherwise surface only on first use.
        let found = super::detect("Dr. Weber, 221B Baker Street, London; SSN 123-45-6789; phone: 555 0199 22");
        assert!(found.len() >= 3, "{found:?}");
    }

    #[test]
    fn open_tails() {
        assert_eq!(open_tail("hello ["), 1);
        assert_eq!(open_tail("hello [EMA"), 4);
        assert_eq!(open_tail("hello [ADDRESS_12"), 11);
        assert_eq!(open_tail("hello [EMAIL_1]"), 0);
        assert_eq!(open_tail("a [link] b"), 0);
        assert_eq!(open_tail("x [Hello"), 0);
        assert_eq!(open_tail("no bracket"), 0);
    }

    #[test]
    fn requests_and_responses_round_trip() {
        let mut body = json!({
            "model": "x",
            "messages": [
                { "role": "system", "content": "be brief" },
                { "role": "user", "content": [{ "type": "text", "text": "mail alice@proton.me" }] },
                { "role": "assistant", "tool_calls": [{ "function": { "name": "send", "arguments": "{\"to\":\"alice@proton.me\"}" } }] }
            ]
        });
        let vault = redact_request(&mut body);
        assert_eq!(body["messages"][1]["content"][0]["text"], "mail [EMAIL_1]");
        assert_eq!(body["messages"][2]["tool_calls"][0]["function"]["arguments"], "{\"to\":\"[EMAIL_1]\"}");
        let mut answer = json!({ "choices": [{ "message": { "content": "Sent to [EMAIL_1]. [EMAIL_9] stays." } }] });
        restore_response(&vault, &mut answer);
        assert_eq!(answer["choices"][0]["message"]["content"], "Sent to alice@proton.me. [EMAIL_9] stays.");
    }

    #[test]
    fn values_are_found_again_in_later_messages() {
        let mut body = json!({ "messages": [
            { "role": "user", "content": "My friend Zork Blax is visiting." },
            { "role": "user", "content": "Blax arrives at 5; text +44 20 7946 0958 or +442079460958" }
        ]});
        let vault = redact_request(&mut body);
        assert_eq!(body["messages"][0]["content"], "My friend [PERSON_1] is visiting.");
        assert_eq!(body["messages"][1]["content"], "[PERSON_2] arrives at 5; text [PHONE_1] or [PHONE_1]");
        assert_eq!(vault.restore("[PERSON_2]"), "Blax");
    }

    #[test]
    fn encoded_placeholders_are_restored_encoded() {
        let mut vault = Vault::default();
        assert_eq!(vault.redact("bob@posteo.de"), "[EMAIL_1]");
        assert_eq!(vault.restore("mailto:%5BEMAIL_1%5D"), "mailto:bob%40posteo.de");
    }

    #[test]
    fn streams_restore_split_placeholders() {
        let mut vault = Vault::default();
        assert_eq!(vault.redact("call +44 20 7946 0958"), "call [PHONE_1]");
        let mut restorer = StreamRestorer::new(vault);
        let chunk =
            |s: &str| format!("data: {}\n\n", json!({ "choices": [{ "index": 0, "delta": { "content": s } }] }));
        let mut out = Vec::new();
        for part in ["Your number is [PH", "ONE_", "1] and [x] ok"] {
            out.extend(restorer.push(chunk(part).as_bytes()));
        }
        out.extend(restorer.push(b"data: [DONE]\n\n"));
        out.extend(restorer.finish());
        let text: String = String::from_utf8(out)
            .unwrap()
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter(|d| *d != "[DONE]")
            .map(|d| {
                serde_json::from_str::<serde_json::Value>(d).unwrap()["choices"][0]["delta"]["content"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned()
            })
            .collect();
        assert_eq!(text, "Your number is +44 20 7946 0958 and [x] ok");
    }

    #[test]
    fn a_held_tail_is_flushed_when_the_choice_finishes() {
        let mut restorer = StreamRestorer::new(Vault::default());
        let out = restorer.push(
            format!("data: {}\n", json!({ "choices": [{ "index": 0, "delta": { "content": "x [EM" } }] })).as_bytes(),
        );
        assert!(!String::from_utf8_lossy(&out).contains("[EM"));
        let out = restorer.push(
            format!("data: {}\n", json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] }))
                .as_bytes(),
        );
        assert!(String::from_utf8_lossy(&out).contains("[EM"));
    }
}
