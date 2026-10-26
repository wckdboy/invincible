//! Redaction before a request leaves the node (spec/redaction.md): a port of Autobot's
//! `PiiDetector` (detection) and `RedactionVault` (placeholders `[KIND_N]`, restoring them in
//! answers, streams too), so the phone and the node hide the same things.
//!
//! The `regex` crate has no look-around or back-references, so each pattern with look-around
//! matches its one character of context instead and captures the core in group 1. Leftmost-first
//! matching picks the same core a backtracking engine with look-around would.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};

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
// Digits with at most one separator between two: a space of any width (also a no-break or narrow
// no-break space, as web pages, office documents and contacts write it), `-`, `.` or `/`. Not a
// tab or a line break: those separate cells and lines, not the groups of one number.
static DIGIT_RUN: LazyLock<Regex> = LazyLock::new(|| re(r"\+?[0-9](?:[\p{Zs}\-./]?[0-9])*"));
static LATIN: LazyLock<Regex> = LazyLock::new(|| re(r"\p{Latin}"));
static CASED: LazyLock<Regex> = LazyLock::new(|| re(r"[\p{Latin}\p{Cased}]"));

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
    find(text, true)
}

/// [detect]; names and addresses ([Kind::wordy]) only with [words].
fn find(text: &str, words: bool) -> Vec<Span> {
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
    if words {
        addresses(text, &guards, &mut found);
        people(text, &guards, &mut found);
    }

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

/// [literal]: placeholder-shaped text the user wrote themselves ("[PERSON_1]"). [unescaped]: what
/// [value] stood for, where it was found written as inside a JSON string (`12a,\n10115 Berlin` in
/// JSON lines, a line break): it goes back into JSON as that, and into text as it was written.
struct Entry {
    kind: Kind,
    value: String,
    placeholder: Option<String>,
    digits: Option<String>,
    forms: Vec<String>,
    literal: bool,
    unescaped: Option<String>,
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

fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Whether [c] next to a value of [kind] makes it part of a longer word or number: for phone, card
/// and account numbers an ASCII letter, digit or `_`, as their patterns read it; for names and
/// addresses a digit, `_` or a letter of the Latin script or of another script with case (Greek,
/// Cyrillic), the scripts they are found in by their capitals; for the rest a digit, `_` or a
/// letter of the Latin script. A letter of a script without case does not: a particle or word in
/// it may follow a value without a space (`010-1234-5678으로`, `Annaさん`, `bob@posteo.deまで`).
fn joins(kind: Kind, c: char) -> bool {
    if kind.numeric() {
        return c.is_ascii_alphanumeric() || c == '_';
    }
    let letters = if kind.wordy() { &CASED } else { &LATIN };
    c.is_numeric() || c == '_' || (c.is_alphabetic() && letters.is_match(c.encode_utf8(&mut [0; 4])))
}

/// Not part of a longer word or number ([joins]). A JSON escape next to it counts as what it
/// stands for: in `"Hi,\nHannah"` the `n` of `\n` is a line break, not a letter.
fn bounded(text: &str, start: usize, end: usize, kind: Kind) -> bool {
    let before = escape_before(text, start).or_else(|| text[..start].chars().next_back()).unwrap_or(' ');
    let after = escape_at(text, end).map(|(c, _)| c).or_else(|| text[end..].chars().next()).unwrap_or(' ');
    !joins(kind, before) && !joins(kind, after)
}

/// What the JSON escape at [at] stands for (`\n`, `\u00e9`), and its length in bytes. None where
/// there is none, or where its backslash is itself escaped (`\\n` is a backslash and an `n`).
fn escape_at(text: &str, at: usize) -> Option<(char, usize)> {
    let bytes = text.as_bytes();
    if bytes.get(at) != Some(&b'\\') || bytes[..at].iter().rev().take_while(|&&b| b == b'\\').count() % 2 == 1 {
        return None;
    }
    match bytes.get(at + 1)? {
        b'n' => Some(('\n', 2)),
        b'r' => Some(('\r', 2)),
        b't' => Some(('\t', 2)),
        b'b' => Some(('\u{8}', 2)),
        b'f' => Some(('\u{c}', 2)),
        b'u' => {
            let hex = text.get(at + 2..at + 6).filter(|h| h.bytes().all(|b| b.is_ascii_hexdigit()))?;
            let code = u32::from_str_radix(hex, 16).ok()?;
            // Half of a surrogate pair: not a letter on its own.
            Some((char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER), 6))
        }
        _ => None,
    }
}

/// What a JSON escape that ends at [at] stands for.
fn escape_before(text: &str, at: usize) -> Option<char> {
    [2, 6].into_iter().find_map(|len| escape_at(text, at.checked_sub(len)?).filter(|&(_, l)| l == len).map(|(c, _)| c))
}

/// [at], or the end of the JSON escape it lies inside: an email's local part may begin with the `u`
/// and hex digits of the `\u306f` before it.
fn past_escape(text: &str, at: usize) -> usize {
    (1..6)
        .filter_map(|back| at.checked_sub(back))
        .find_map(|start| escape_at(text, start).map(|(_, len)| start + len))
        .filter(|&end| end > at)
        .unwrap_or(at)
}

/// [text] as detection reads it: a JSON escape that stands for something other than a letter, a
/// digit or `_` is written as spaces, ending in the line break or tab it stands for, so a value
/// right after `\n` is found without the `n` and every offset holds in [text].
fn spaced(text: &str) -> Cow<'_, str> {
    if !text.contains('\\') {
        return Cow::Borrowed(text);
    }
    let mut out = text.as_bytes().to_vec();
    let mut at = 0;
    while at < out.len() {
        if out[at] != b'\\' {
            at += 1;
            continue;
        }
        // A run of backslashes is read once: its pairs are `\\`, kept as written, and only an odd
        // one out at its end can start an escape (asking [escape_at] at each pair would recount
        // the run every time).
        let run = out[at..].iter().take_while(|&&b| b == b'\\').count();
        at += run - run % 2;
        if run % 2 == 0 {
            continue;
        }
        match escape_at(text, at) {
            Some((c, len)) if !word_char(c) => {
                out[at..at + len].fill(b' ');
                if matches!(c, '\n' | '\r' | '\t') {
                    out[at + len - 1] = c as u8;
                }
                at += len;
            }
            Some((_, len)) => at += len,
            // `\"`, or a backslash that escapes nothing: kept as written.
            None => at += 2,
        }
    }
    Cow::Owned(String::from_utf8(out).expect("only ASCII bytes replaced by ASCII"))
}

/// What [raw] stands for as the inside of a JSON string, where it has an escape and reads as one.
fn unescape(raw: &str) -> Option<String> {
    raw.contains('\\').then(|| serde_json::from_str(&format!("\"{raw}\"")).ok()).flatten()
}

/// Whether [text] is a JSON object or array: a string of a tool result may hold one (an MCP tool's
/// result passed on as text), and a `\n` in it then stands for a line break. Other text in a string
/// (code, JSON lines) is read as text: there a `\n` may be a backslash and an `n`. It is parsed as a
/// [Value], as [Vault::redact_document] needs: text with a lone surrogate (`\ud800`) is not JSON.
fn holds_json(text: &str) -> bool {
    text.trim_start().starts_with(['{', '[']) && serde_json::from_str::<Value>(text).is_ok()
}

/// [value] as it is written inside a JSON string (a line break as `\n`).
fn json_escape(value: &str) -> String {
    let quoted = Value::String(value.to_owned()).to_string();
    quoted[1..quoted.len() - 1].to_owned()
}

/// [e]'s forms as written inside a JSON string, where that differs from the form.
fn escaped_forms(e: &Entry) -> Vec<String> {
    e.forms.iter().map(|f| json_escape(f)).filter(|f| !e.forms.contains(f)).collect()
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
            unescaped: None,
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

    /// The entry for a detected value, new or known. It gets its placeholder when it is replaced.
    /// A new value with an escape, found in a JSON text read as text ([json]), is also known by what
    /// it stands for, so the same value read unescaped later (in a JSON document, a message) is the
    /// same. A known value stays as it was first registered.
    fn register(&mut self, kind: Kind, value: &str, json: bool) -> usize {
        let k = key(kind, value);
        let unescaped = if json { unescape(value) } else { None };
        let unescaped_key = unescaped.as_deref().map(|u| key(kind, u));
        if let Some(&i) = self.index.get(&k).or_else(|| self.index.get(unescaped_key.as_ref()?)) {
            if !self.entries[i].1.forms.iter().any(|f| f == value) {
                self.entries[i].1.forms.push(value.to_owned());
            }
            return i;
        }
        let i = self.insert(
            k,
            Entry {
                kind,
                value: value.to_owned(),
                placeholder: None,
                digits: digits_of(kind, unescaped.as_deref().unwrap_or(value)),
                forms: std::iter::once(value.to_owned()).chain(unescaped.clone()).collect(),
                literal: false,
                unescaped,
            },
        );
        if let Some(unescaped_key) = unescaped_key {
            self.index.insert(unescaped_key, i);
        }
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
        i
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
                unescaped: None,
            },
        );
    }

    /// [text] with its personal data replaced.
    pub fn redact(&mut self, text: &str) -> String {
        self.redact_with(text, Form::Text)
    }

    /// [Vault::redact] for a tool's description, which goes with every request: only what is
    /// found without guessing at words (emails, phone, card, IBAN and account numbers), so "a file
    /// called Report" or "Hi Claude," names no one who would then be replaced in every message.
    /// Values already known are replaced as in any text.
    pub fn redact_description(&mut self, text: &str) -> String {
        self.redact_with(text, Form::Description)
    }

    /// [Vault::redact] for a text that is often JSON (a tool result, tool-call arguments). When it
    /// parses, each string in it (keys too) is redacted as what it stands for, unescaped, and
    /// written back escaped; a number is redacted as written and becomes a string if it changes. So
    /// a value right after a `\n` is found whole and the text stays JSON. A string in it that is
    /// itself a JSON object or array ([holds_json]) is read the same way. Other text (JSON lines,
    /// JSON inside prose) is redacted as text, and a value with an escape found in it is taken as
    /// written inside a JSON string ([Entry::unescaped]).
    pub fn redact_json(&mut self, text: &str) -> String {
        if serde_json::from_str::<Value>(text).is_err() {
            return self.redact_with(text, Form::Json);
        }
        self.redact_document(text)
    }

    /// [Vault::redact_json] for a text that parses as a JSON [Value]: each string in it parses too.
    fn redact_document(&mut self, text: &str) -> String {
        // As in a text, placeholder-shaped text anywhere in it comes first.
        for c in PLACEHOLDER.captures_iter(text) {
            self.literal(&c[1], &c[2], &c[3]);
        }
        let bytes = text.as_bytes();
        let mut out = String::with_capacity(text.len());
        let (mut cursor, mut at) = (0, 0);
        while at < bytes.len() {
            // Valid JSON: outside a string, a `-` or a digit starts a number.
            let end = match bytes[at] {
                b'"' => {
                    let mut end = at + 1;
                    while bytes[end] != b'"' {
                        end += if bytes[end] == b'\\' { 2 } else { 1 };
                    }
                    end + 1
                }
                b'-' | b'0'..=b'9' => {
                    at + bytes[at..]
                        .iter()
                        .take_while(|b| matches!(b, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'))
                        .count()
                }
                _ => {
                    at += 1;
                    continue;
                }
            };
            let token = &text[at..end];
            let string = bytes[at] == b'"';
            let value = if string { serde_json::from_str(token).expect("a JSON string") } else { token.to_owned() };
            let redacted =
                if string && holds_json(&value) { self.redact_document(&value) } else { self.redact(&value) };
            if redacted != value {
                out.push_str(&text[cursor..at]);
                out.push_str(&Value::String(redacted).to_string());
                cursor = end;
            }
            at = end;
        }
        out.push_str(&text[cursor..]);
        out
    }

    fn redact_with(&mut self, text: &str, form: Form) -> String {
        if text.trim().is_empty() {
            return text.to_owned();
        }
        let read = spaced(text);
        let spans = find(&read, form != Form::Description);
        // Placeholder-shaped text the user wrote comes first: its numbers are never handed out.
        let literals: Vec<(String, String, String)> =
            PLACEHOLDER.captures_iter(text).map(|c| (c[1].to_owned(), c[2].to_owned(), c[3].to_owned())).collect();
        for (open, tag, n) in &literals {
            self.literal(open, tag, n);
        }
        // What is detected inside a known value written escaped (`12a,\n10115 Berlin`) is part of
        // that value, not a new one.
        let escaped = self.escaped_hits(text);
        let mut found = Vec::new();
        for span in spans {
            let start = past_escape(text, span.start);
            if start >= span.end {
                continue;
            }
            found.push(match escaped.iter().find(|&&(s, e, _)| s <= start && span.end <= e) {
                Some(&hit) => hit,
                None => (start, span.end, self.register(span.kind, &text[start..span.end], form == Form::Json)),
            });
        }
        self.replace(text, &read, found)
    }

    /// Where a known value is written escaped for a JSON string, and differently from how it was
    /// found (a value with a line break or a quote, echoed in JSON): (start, end, entry).
    fn escaped_hits(&self, text: &str) -> Vec<(usize, usize, usize)> {
        if !text.contains('\\') {
            return Vec::new();
        }
        let mut hits = Vec::new();
        for (i, (_, e)) in self.entries.iter().enumerate() {
            for form in escaped_forms(e) {
                let found = text.match_indices(form.as_str()).map(|(at, f)| (at, at + f.len(), i));
                hits.extend(found.filter(|&(start, end, _)| bounded(text, start, end, e.kind)));
            }
        }
        hits
    }

    /// Replaces what detection found in [text] ([detected]: start, end, entry) where it was found,
    /// whatever is next to it, and every occurrence of a known value (earliest, then longest first,
    /// no overlaps), also where it is written escaped for a JSON string (a tool result, tool-call
    /// arguments). A known value that overlaps what was found is replaced only where it covers it.
    /// [read] is [text] as detection read it ([spaced]), where a link ends at an escaped line break.
    fn replace(&mut self, text: &str, read: &str, mut detected: Vec<(usize, usize, usize)>) -> String {
        let guards = Guards::new(read);
        let mut lower: Option<String> = None;
        let mut hits: Vec<(usize, usize, usize)> = Vec::new();
        // An escaped form that differs has a backslash.
        let json = text.contains('\\');
        for (i, (_, e)) in self.entries.iter().enumerate() {
            let escaped = if json { escaped_forms(e) } else { Vec::new() };
            for form in e.forms.iter().chain(&escaped) {
                let found: Vec<(usize, usize)> = if e.kind == Kind::Email && form.is_ascii() {
                    // Any case: ASCII lowercasing keeps every byte where it was, so the offsets
                    // hold in [text] (no pattern compiled for each address and each text).
                    let lower = lower.get_or_insert_with(|| text.to_ascii_lowercase());
                    let form = form.to_ascii_lowercase();
                    lower.match_indices(form.as_str()).map(|(at, f)| (at, at + f.len())).collect()
                } else if e.kind == Kind::Email {
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
                    if !bounded(text, start, end, e.kind) || (e.kind.wordy() && guards.blocked(start, end)) {
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
                // A run that begins in the hex digits of a `\uXXXX` begins after it, at its first
                // digit (`\ud63801012345678` and `\ud638 01012345678` are 호 and a number).
                let from = past_escape(text, m.start());
                if from >= m.end() {
                    continue;
                }
                let run = text[from..m.end()].trim_start_matches(|c: char| !c.is_ascii_digit() && c != '+');
                let digits: String = run.chars().filter(char::is_ascii_digit).collect();
                if let Some(&i) = by_digits.get(digits.as_str()) {
                    // A `+` the value was found without stays in the text (it would not come
                    // back: the value is restored as it was found).
                    let plus = run.starts_with('+') && !self.entries[i].1.value.starts_with('+');
                    let start = m.end() - run.len() + usize::from(plus);
                    if bounded(text, start, m.end(), self.entries[i].1.kind) {
                        hits.push((start, m.end(), i));
                    }
                }
            }
        }
        if hits.is_empty() && detected.is_empty() {
            return text.to_owned();
        }
        // What was found, without overlaps (the spans inside a known value written escaped are all
        // that value).
        detected.sort_by_key(|&(start, end, _)| (start, std::cmp::Reverse(end)));
        detected.dedup_by(|next, kept| next.0 < kept.1);
        hits.sort_by_key(|&(start, end, _)| (start, std::cmp::Reverse(end)));
        let mut taken: Vec<(usize, usize, usize)> = Vec::new();
        let mut covered = vec![false; detected.len()];
        for (start, end, i) in hits {
            if taken.last().is_some_and(|&(_, last, _)| start < last) {
                continue;
            }
            // The spans found that this hit overlaps (sorted, apart): it must cover each of them.
            let from = detected.partition_point(|&(_, e, _)| e <= start);
            let to = from + detected[from..].partition_point(|&(s, _, _)| s < end);
            if detected[from..to].iter().any(|&(s, e, _)| s < start || e > end) {
                continue;
            }
            covered[from..to].fill(true);
            taken.push((start, end, i));
        }
        taken.extend(detected.into_iter().zip(covered).filter(|&(_, covered)| !covered).map(|(hit, _)| hit));
        taken.sort_by_key(|&(start, _, _)| start);
        let mut out = String::with_capacity(text.len());
        let mut cursor = 0;
        for (start, end, i) in taken {
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
        self.restore_in(text, false)
    }

    /// [Vault::restore] for JSON text (tool-call arguments): values come back escaped for a JSON
    /// string, so a value with a line break leaves the arguments valid JSON. A value first found
    /// written as inside a JSON string comes back as it was written there, so it reads as it did.
    pub fn restore_json(&self, text: &str) -> String {
        self.restore_in(text, true)
    }

    fn restore_in(&self, text: &str, json: bool) -> String {
        if self.by_placeholder.is_empty() || (!text.contains('[') && !text.contains('%')) {
            return text.to_owned();
        }
        PLACEHOLDER
            .replace_all(text, |caps: &regex::Captures| {
                let bracket = format!("[{}_{}]", &caps[2], &caps[3]);
                let Some(&i) = self.by_placeholder.get(&bracket) else { return caps[0].to_owned() };
                let e = &self.entries[i].1;
                match (&caps[1] == "[", json, e.unescaped.as_deref()) {
                    (true, true, None) => json_escape(&e.value),
                    (true, _, _) => e.value.clone(),
                    (false, true, Some(unescaped)) => percent_encode(unescaped),
                    (false, _, _) => percent_encode(&e.value),
                }
            })
            .into_owned()
    }

    /// Drops the placeholders [shown] does not hold: their values are neither counted nor restored.
    fn keep_shown(&mut self, shown: &HashSet<&str>) {
        for (_, e) in &mut self.entries {
            if let Some(p) = e.placeholder.take_if(|p| !e.literal && !shown.contains(p.as_str())) {
                self.by_placeholder.remove(&p);
            }
        }
    }

    /// Distinct personal values hidden, per kind tag: each value counts once it was replaced.
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

/// How a text of a request is redacted.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Form {
    /// [Vault::redact].
    Text,
    /// A tool result or tool-call arguments: [Vault::redact_json] (in [Vault::redact_with], one
    /// that is not a JSON document, read as text).
    Json,
    /// A tool's description: [Vault::redact_description].
    Description,
}

/// The texts of a chat completion request that redaction covers, in order. What stays the same for
/// a whole conversation (the `user` field, the tools) comes first, so its placeholders keep their
/// numbers as the conversation grows.
fn request_texts(body: &mut Value) -> Vec<(&mut String, Form)> {
    let (mut user, mut tools, mut messages) = (Vec::new(), Vec::new(), Vec::new());
    let Some(body) = body.as_object_mut() else { return messages };
    for (field, value) in body.iter_mut() {
        match (field.as_str(), value) {
            ("user", Value::String(s)) => user.push((s, Form::Text)),
            ("tools", Value::Array(list)) => {
                for tool in list {
                    if let Some(function) = tool.get_mut("function") {
                        descriptions(function, &mut tools);
                    }
                }
            }
            ("messages", Value::Array(list)) => {
                for message in list {
                    message_texts(message, &mut messages);
                }
            }
            _ => {}
        }
    }
    user.extend(tools);
    user.extend(messages);
    user
}

/// Every string `description` in a tool's function: its own, and its parameters' at any depth (a
/// property that is itself called `description` is a schema, not a string, and is looked into).
fn descriptions<'a>(value: &'a mut Value, out: &mut Vec<(&'a mut String, Form)>) {
    match value {
        Value::Object(map) => {
            for (key, value) in map.iter_mut() {
                match value {
                    Value::String(s) => {
                        if key == "description" {
                            out.push((s, Form::Description));
                        }
                    }
                    other => descriptions(other, out),
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                descriptions(item, out);
            }
        }
        _ => {}
    }
}

/// A message's texts: its content (a tool result's as JSON), its reasoning (`reasoning_content`,
/// `reasoning`), then its tool calls' arguments.
fn message_texts<'a>(message: &'a mut Value, out: &mut Vec<(&'a mut String, Form)>) {
    let Some(message) = message.as_object_mut() else { return };
    let result = matches!(message.get("role").and_then(Value::as_str), Some("tool" | "function"));
    let content = if result { Form::Json } else { Form::Text };
    let (mut reasoning, mut calls) = (Vec::new(), Vec::new());
    for (field, value) in message.iter_mut() {
        match (field.as_str(), value) {
            ("content", Value::String(s)) => out.push((s, content)),
            ("content", Value::Array(parts)) => {
                for part in parts {
                    if let Some(Value::String(s)) = part.get_mut("text") {
                        out.push((s, content));
                    }
                }
            }
            ("reasoning_content" | "reasoning", Value::String(s)) => reasoning.push((s, Form::Text)),
            ("tool_calls", Value::Array(list)) => {
                for call in list {
                    if let Some(Value::String(args)) = call.pointer_mut("/function/arguments") {
                        calls.push((args, Form::Json));
                    }
                }
            }
            _ => {}
        }
    }
    out.extend(reasoning);
    out.extend(calls);
}

/// Redacts a chat completion request in place; the vault restores the answer.
pub fn redact_request(body: &mut Value) -> Vault {
    let mut vault = Vault::default();
    let mut texts = request_texts(body);
    let mut descriptions = Vec::new();
    for (at, (text, form)) in texts.iter_mut().enumerate() {
        **text = match form {
            Form::Text => vault.redact(text),
            Form::Json => vault.redact_json(text),
            Form::Description => {
                descriptions.push((at, text.clone()));
                vault.redact_description(text)
            }
        };
    }
    // The descriptions come first, for their numbers; written again from what they were, they also
    // lose the values the messages brought.
    if !descriptions.is_empty() {
        for (at, original) in descriptions {
            *texts[at].0 = vault.redact_description(&original);
        }
        // A value the first pass hid that the second covers with a longer one is hidden nowhere.
        let shown: HashSet<&str> =
            texts.iter().flat_map(|(text, _)| PLACEHOLDER.find_iter(text).map(|m| m.as_str())).collect();
        vault.keep_shown(&shown);
    }
    vault
}

/// The fields of a message, or of a streamed delta, that carry text: the answer and its reasoning.
const TEXT_FIELDS: [&str; 3] = ["content", "reasoning_content", "reasoning"];

/// Restores a whole (non-streamed) chat completion response in place: each message's text, its
/// reasoning and its tool calls' arguments.
pub fn restore_response(vault: &Vault, body: &mut Value) {
    let Some(choices) = body.get_mut("choices").and_then(Value::as_array_mut) else { return };
    for choice in choices {
        let Some(message) = choice.get_mut("message").and_then(Value::as_object_mut) else { continue };
        for (field, value) in message.iter_mut() {
            match (field.as_str(), value) {
                (field, Value::String(s)) if TEXT_FIELDS.contains(&field) => *s = vault.restore(s),
                ("tool_calls", Value::Array(calls)) => {
                    for call in calls {
                        if let Some(Value::String(args)) = call.pointer_mut("/function/arguments") {
                            *args = vault.restore_json(args);
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

/// A text a streamed answer sends in pieces: one of a choice's [TEXT_FIELDS], or the arguments of
/// one of its tool calls (by the call's index).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Channel {
    Text(&'static str),
    Arguments(u64),
}

/// Restores streamed (SSE) chat completion chunks: the text, the reasoning and the tool calls'
/// arguments. A placeholder split across chunks is held back until it is whole or its choice
/// finishes.
pub struct StreamRestorer {
    vault: Vault,
    line: Vec<u8>,
    /// What is held back, per choice index and channel.
    carry: BTreeMap<(u64, Channel), String>,
    /// Where the usage goes instead of to the client ([StreamRestorer::withholding_usage]).
    usage: Option<Arc<Mutex<Option<Value>>>>,
    /// Set after a chunk was kept back: the blank line that ended its event goes too.
    drop_blank: bool,
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

/// [choice]'s delta, made when it has none.
fn delta_of(choice: &mut serde_json::Map<String, Value>) -> Option<&mut serde_json::Map<String, Value>> {
    let delta = choice.entry("delta").or_insert_with(|| Value::Object(serde_json::Map::new()));
    if delta.is_null() {
        *delta = Value::Object(serde_json::Map::new());
    }
    delta.as_object_mut()
}

impl StreamRestorer {
    pub fn new(vault: Vault) -> Self {
        Self { vault, line: Vec::new(), carry: BTreeMap::new(), usage: None, drop_blank: false }
    }

    /// Also keeps the usage from the client: the node asked the provider for it and the client did
    /// not. It goes to [into] from whichever chunk carries it: one of its own (`"choices": []`,
    /// as OpenAI sends it), which is then not sent, or the last one with the finished choice (as
    /// DeepSeek sends it), which is sent without it. The other chunks lose the `"usage": null`
    /// that asking added.
    pub fn withholding_usage(mut self, into: Arc<Mutex<Option<Value>>>) -> Self {
        self.usage = Some(into);
        self
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
        for ((index, channel), text) in std::mem::take(&mut self.carry) {
            if text.is_empty() {
                continue;
            }
            let delta = match channel {
                Channel::Text(field) => {
                    serde_json::Map::from_iter([(field.to_owned(), Value::String(self.vault.restore(&text)))]).into()
                }
                Channel::Arguments(call) => serde_json::json!({ "tool_calls": [
                    { "index": call, "function": { "arguments": self.vault.restore_json(&text) } }
                ] }),
            };
            let chunk = serde_json::json!({ "choices": [{ "index": index, "delta": delta }] });
            out.extend(format!("data: {chunk}\n\n").into_bytes());
        }
        out
    }

    /// The next piece of [channel] to send on: [piece] (if this chunk has one) after what was held
    /// back of it, restored, with a tail that may still become a placeholder held back unless the
    /// choice has [finished].
    fn pass(&mut self, choice: u64, channel: Channel, piece: Option<&str>, finished: bool) -> String {
        let mut text = self.carry.remove(&(choice, channel)).unwrap_or_default();
        text.push_str(piece.unwrap_or_default());
        let keep = if finished { 0 } else { open_tail(&text) };
        let (send, hold) = text.split_at(text.len() - keep);
        if !hold.is_empty() {
            self.carry.insert((choice, channel), hold.to_owned());
        }
        match channel {
            Channel::Text(_) => self.vault.restore(send),
            Channel::Arguments(_) => self.vault.restore_json(send),
        }
    }

    fn line_out(&mut self, line: &[u8]) -> Vec<u8> {
        if std::mem::take(&mut self.drop_blank) && line.trim_ascii().is_empty() {
            return Vec::new();
        }
        let Ok(text) = std::str::from_utf8(line) else { return line.to_vec() };
        let Some(data) = text.strip_prefix("data:") else { return line.to_vec() };
        let data = data.trim();
        if data == "[DONE]" {
            let mut out = self.flush_all();
            out.extend_from_slice(line);
            return out;
        }
        let Ok(mut chunk) = serde_json::from_str::<Value>(data) else { return line.to_vec() };
        // Usage the node asked for leaves every chunk: the one that carries it for [into], the
        // others' `"usage": null` for nothing.
        if let Some(into) = &self.usage
            && let Some(object) = chunk.as_object_mut()
            && let Some(usage) = object.remove("usage")
            && usage.is_object()
        {
            *into.lock().expect("usage lock") = Some(usage);
            // Nothing left for the client.
            if object.get("choices").and_then(Value::as_array).is_none_or(Vec::is_empty) {
                self.drop_blank = true;
                return Vec::new();
            }
        }
        if let Some(choices) = chunk.get_mut("choices").and_then(Value::as_array_mut) {
            for choice in choices {
                self.restore_choice(choice);
            }
        }
        format!("data: {chunk}\n").into_bytes()
    }

    fn restore_choice(&mut self, choice: &mut Value) {
        let index = choice.get("index").and_then(Value::as_u64).unwrap_or(0);
        let finished = choice.get("finish_reason").is_some_and(|f| !f.is_null());
        let Some(choice) = choice.as_object_mut() else { return };
        for field in TEXT_FIELDS {
            let piece = choice.get("delta").and_then(|d| d.get(field)).and_then(Value::as_str).map(str::to_owned);
            let restored = self.pass(index, Channel::Text(field), piece.as_deref(), finished);
            if (piece.is_some() || !restored.is_empty())
                && let Some(delta) = delta_of(choice)
            {
                delta.insert(field.to_owned(), Value::String(restored));
            }
        }
        // Each call's arguments are held back on their own. A call without an index (a server
        // that sends whole calls) is restored as it comes.
        if let Some(calls) = choice.get_mut("delta").and_then(|d| d.get_mut("tool_calls")).and_then(Value::as_array_mut)
        {
            for call in calls {
                let at = call.get("index").and_then(Value::as_u64);
                let Some(Value::String(args)) = call.pointer_mut("/function/arguments") else { continue };
                *args = match at {
                    Some(at) => self.pass(index, Channel::Arguments(at), Some(args.as_str()), finished),
                    None => self.vault.restore_json(args),
                };
            }
        }
        if !finished {
            return;
        }
        // The choice is done: what is still held of calls this chunk does not continue goes with it.
        let held: Vec<u64> = self
            .carry
            .keys()
            .filter_map(|&(c, channel)| match channel {
                Channel::Arguments(at) if c == index => Some(at),
                _ => None,
            })
            .collect();
        for at in held {
            let restored = self.pass(index, Channel::Arguments(at), None, true);
            if restored.is_empty() {
                continue;
            }
            let Some(delta) = delta_of(choice) else { continue };
            let calls = delta.entry("tool_calls").or_insert_with(|| Value::Array(Vec::new()));
            if !calls.is_array() {
                *calls = Value::Array(Vec::new());
            }
            if let Some(calls) = calls.as_array_mut() {
                calls.push(serde_json::json!({ "index": at, "function": { "arguments": restored } }));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{StreamRestorer, Vault, open_tail, redact_request, restore_response};
    use serde_json::json;
    use std::collections::BTreeMap;

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

    fn content_of(sse: &[u8]) -> String {
        String::from_utf8_lossy(sse)
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter(|d| *d != "[DONE]")
            .filter_map(|d| serde_json::from_str::<serde_json::Value>(d).ok())
            .map(|v| v["choices"][0]["delta"]["content"].as_str().unwrap_or("").to_owned())
            .collect()
    }

    const PIECES: &[&str] = &[
        "bob@posteo.de",
        "Bob@Posteo.DE",
        "+44 20 7946 0958",
        "DE89 3704 0044 0532 0130 00",
        "[EMAIL_1]",
        "[PHONE_1]",
        "[PERSON_1]",
        "[",
        "]",
        "[EM",
        "AIL_",
        "1]",
        " ",
        "\n",
        "Zork Blax",
        "%5BEMAIL_1%5D",
        "\"",
        "\\",
        "é",
        "🙂",
    ];

    #[test]
    fn redaction_is_undone_exactly_for_any_text() {
        crate::testgen::cases("redact/restore", |g| {
            let text = g.assemble(PIECES, 24);
            let mut vault = Vault::default();
            let redacted = vault.redact(&text);
            let restored = vault.restore(&redacted);
            // An address is one whatever its case, and comes back as it was first written.
            if text.contains("Bob@Posteo.DE") {
                assert_eq!(restored.to_ascii_lowercase(), text.to_ascii_lowercase(), "redacted as {redacted:?}");
            } else {
                assert_eq!(restored, text, "redacted as {redacted:?}");
            }
        });
    }

    #[test]
    fn json_is_redacted_as_json_and_undone_exactly() {
        crate::testgen::cases("redact_json/restore_json", |g| {
            let list: Vec<String> = (0..g.below(4)).map(|_| g.assemble(PIECES, 8)).collect();
            // A string that holds JSON text, as an MCP tool's result does.
            let inner = json!({ "d": g.assemble(PIECES, 8), "e": [g.assemble(PIECES, 4)] }).to_string();
            let text = json!({ "a": g.assemble(PIECES, 12), "b": list, "c": inner, "n": -1.5e3 }).to_string();
            let mut vault = Vault::default();
            let redacted = vault.redact_json(&text);
            serde_json::from_str::<serde_json::Value>(&redacted).expect("still JSON");
            let restored = vault.restore_json(&redacted);
            if text.contains("Bob@Posteo.DE") {
                assert_eq!(restored.to_ascii_lowercase(), text.to_ascii_lowercase(), "redacted as {redacted:?}");
            } else {
                assert_eq!(restored, text, "redacted as {redacted:?}");
            }
        });
    }

    #[test]
    fn a_stream_restores_the_same_however_it_is_cut() {
        crate::testgen::cases("stream restore", |g| {
            let make = || {
                let mut vault = Vault::default();
                for known in ["bob@posteo.de", "call +44 20 7946 0958"] {
                    vault.redact(known);
                }
                vault
            };
            let vault = make();
            let deltas: Vec<String> = (0..g.below(8)).map(|_| g.assemble(PIECES, 5)).collect();
            let mut sse = Vec::new();
            for d in &deltas {
                sse.extend(
                    format!("data: {}\n\n", json!({ "choices": [{ "index": 0, "delta": { "content": d } }] })).bytes(),
                );
            }
            sse.extend(b"data: [DONE]\n\n");
            let whole = {
                let mut r = StreamRestorer::new(make());
                let mut out = r.push(&sse);
                out.extend(r.finish());
                content_of(&out)
            };
            assert_eq!(whole, vault.restore(&deltas.concat()));
            let mut r = StreamRestorer::new(make());
            let mut out = Vec::new();
            for part in g.split(&sse) {
                out.extend(r.push(part));
            }
            out.extend(r.finish());
            assert_eq!(content_of(&out), whole);
        });
    }

    /// The texts of a streamed answer put back together: (content, reasoning_content, reasoning,
    /// each call's arguments by index).
    fn channels_of(sse: &[u8]) -> (String, String, String, BTreeMap<u64, String>) {
        let (mut content, mut reasoning_content, mut reasoning) = (String::new(), String::new(), String::new());
        let mut calls = BTreeMap::new();
        for data in String::from_utf8_lossy(sse).lines().filter_map(|l| l.strip_prefix("data: ")) {
            let Ok(chunk) = serde_json::from_str::<serde_json::Value>(data) else { continue };
            let delta = &chunk["choices"][0]["delta"];
            content.push_str(delta["content"].as_str().unwrap_or(""));
            reasoning_content.push_str(delta["reasoning_content"].as_str().unwrap_or(""));
            reasoning.push_str(delta["reasoning"].as_str().unwrap_or(""));
            for call in delta["tool_calls"].as_array().into_iter().flatten() {
                let Some(at) = call["index"].as_u64() else { continue };
                let args: &mut String = calls.entry(at).or_default();
                args.push_str(call["function"]["arguments"].as_str().unwrap_or(""));
            }
        }
        (content, reasoning_content, reasoning, calls)
    }

    fn sse(delta: serde_json::Value) -> String {
        format!("data: {}\n\n", json!({ "choices": [{ "index": 0, "delta": delta }] }))
    }

    #[test]
    fn streams_restore_tool_call_arguments_and_reasoning() {
        let mut vault = Vault::default();
        assert_eq!(vault.redact("bob@posteo.de, +44 20 7946 0958"), "[EMAIL_1], [PHONE_1]");
        assert_eq!(vault.redact("Hauptstraße 12a,\n10115 Berlin"), "[ADDRESS_1]");
        let mut restorer = StreamRestorer::new(vault);
        let args = |at: u64, s: &str| json!({ "tool_calls": [{ "index": at, "function": { "arguments": s } }] });
        let mut out = Vec::new();
        for event in [
            sse(json!({ "role": "assistant", "content": null, "reasoning_content": "mail [EM" })),
            sse(json!({ "reasoning_content": "AIL_1] or call [PHO", "reasoning": "[PH" })),
            sse(
                json!({ "tool_calls": [{ "index": 0, "id": "a", "function": { "name": "mail", "arguments": "{\"to\":\"[EMAIL" } }] }),
            ),
            sse(
                json!({ "tool_calls": [{ "index": 1, "id": "b", "function": { "name": "call", "arguments": "{\"n\":\"[PHONE_" } }] }),
            ),
            sse(args(0, "_1]\"}")),
            sse(json!({ "reasoning_content": "NE_1]", "reasoning": "ONE_1]" })),
            // A server that sends whole calls, without an index. Their arguments are JSON too.
            sse(json!({ "tool_calls": [{ "id": "c", "function": {
                "name": "mail", "arguments": "{\"cc\":\"[EMAIL_1]\",\"to\":\"[ADDRESS_1]\"}"
            } }] })),
        ] {
            let sent = restorer.push(event.as_bytes());
            assert!(!String::from_utf8_lossy(&sent).contains("[EMAIL_1]"), "{}", String::from_utf8_lossy(&sent));
            out.extend(sent);
        }
        // Call 1 still holds `[PHONE_`, which can only become `[PHONE_1…`: it goes with the finish.
        let finish = restorer.push(
            format!("data: {}\n\n", json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }] }))
                .as_bytes(),
        );
        assert!(String::from_utf8_lossy(&finish).contains(r#""finish_reason":"tool_calls""#));
        out.extend(finish);
        out.extend(restorer.push(b"data: [DONE]\n\n"));
        out.extend(restorer.finish());
        let (content, reasoning_content, reasoning, calls) = channels_of(&out);
        assert_eq!(content, "");
        assert_eq!(reasoning_content, "mail bob@posteo.de or call +44 20 7946 0958");
        assert_eq!(reasoning, "+44 20 7946 0958");
        assert_eq!(calls[&0], r#"{"to":"bob@posteo.de"}"#);
        assert_eq!(calls[&1], r#"{"n":"[PHONE_"#);
        let text = String::from_utf8(out).unwrap();
        assert!(
            text.contains(r#""arguments":"{\"cc\":\"bob@posteo.de\",\"to\":\"Hauptstraße 12a,\\n10115 Berlin\"}""#),
            "{text}"
        );
        // Nothing to add to a `content` that was null: it stays null.
        assert!(text.contains(r#""content":null"#), "{text}");
    }

    #[test]
    fn values_with_a_line_break_stay_valid_json_in_tool_arguments() {
        let mut body = json!({ "messages": [
            { "role": "user", "content": "Ship to Hauptstraße 12a,\n10115 Berlin please" }
        ] });
        let vault = redact_request(&mut body);
        assert_eq!(body["messages"][0]["content"], "Ship to [ADDRESS_1] please");
        let mut answer = json!({ "choices": [{ "message": {
            "content": "To [ADDRESS_1].",
            "reasoning_content": "The address is [ADDRESS_1]",
            "reasoning": "[ADDRESS_1]",
            "tool_calls": [{ "function": { "name": "ship", "arguments": "{\"to\":\"[ADDRESS_1]\"}" } }]
        } }] });
        restore_response(&vault, &mut answer);
        let message = &answer["choices"][0]["message"];
        assert_eq!(message["content"], "To Hauptstraße 12a,\n10115 Berlin.");
        assert_eq!(message["reasoning_content"], "The address is Hauptstraße 12a,\n10115 Berlin");
        assert_eq!(message["reasoning"], "Hauptstraße 12a,\n10115 Berlin");
        let args = message["tool_calls"][0]["function"]["arguments"].as_str().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(args).expect("valid JSON");
        assert_eq!(parsed["to"], "Hauptstraße 12a,\n10115 Berlin");

        // Sent back on the next turn as the client got it, escaped, the value is found again.
        let mut next = json!({ "messages": [
            { "role": "user", "content": "Ship to Hauptstraße 12a,\n10115 Berlin please" },
            { "role": "assistant", "tool_calls": [{ "function": { "name": "ship", "arguments": args } }] }
        ] });
        let vault = redact_request(&mut next);
        assert_eq!(next["messages"][1]["tool_calls"][0]["function"]["arguments"], r#"{"to":"[ADDRESS_1]"}"#);
        assert_eq!(vault.found()["ADDRESS"], 1);
    }

    #[test]
    fn a_known_value_written_escaped_is_hidden_in_every_text() {
        // The tool got the address escaped in its arguments, and echoes it in a JSON result.
        let mut body = json!({ "messages": [
            { "role": "user", "content": "Ship to Hauptstraße 12a,\n10115 Berlin please" },
            { "role": "tool", "tool_call_id": "c1", "content": "{\"shipped_to\":\"Hauptstraße 12a,\\n10115 Berlin\"}" },
            { "role": "user", "content": [{ "type": "text", "text": "It said \"Hauptstraße 12a,\\n10115 Berlin\"" }] }
        ] });
        let vault = redact_request(&mut body);
        assert_eq!(body["messages"][1]["content"], r#"{"shipped_to":"[ADDRESS_1]"}"#);
        assert_eq!(body["messages"][2]["content"][0]["text"], r#"It said "[ADDRESS_1]""#);
        // What detection sees inside the escaped value is part of it, not a value of its own.
        assert_eq!(vault.found()["ADDRESS"], 1);
        // Escaped as spec/redaction.md says.
        assert_eq!(super::json_escape("\"\\\n\r\t\u{8}\u{c}\u{1}\u{7f}ß"), "\\\"\\\\\\n\\r\\t\\b\\f\\u0001\u{7f}ß");
    }

    #[test]
    fn a_value_right_after_a_json_escape_is_hidden() {
        let label = json!({ "label": "Recipient:\nHauptstraße 12a,\n10115 Berlin" }).to_string();
        let mut body = json!({ "messages": [
            { "role": "user", "content": "Ship to Hauptstraße 12a,\n10115 Berlin for Hannah Weber, account number is 12345678" },
            { "role": "assistant", "tool_calls": [{ "function": { "name": "label", "arguments": label } }] },
            { "role": "tool", "tool_call_id": "c1", "content": json!({
                "note": "Hi,\nHannah Weber",
                "from": "From:\nbob@posteo.de",
                "account": 12345678,
            }).to_string() },
            // JSON that escapes non-ASCII, and a tool result as text parts.
            { "role": "tool", "tool_call_id": "c2", "content": [
                { "type": "text", "text": r#"{"to":"Hauptstra\u00dfe 12a,\n10115 Berlin"}"# }
            ] }
        ] });
        let vault = redact_request(&mut body);
        let messages = &body["messages"];
        assert_eq!(messages[0]["content"], "Ship to [ADDRESS_1] for [PERSON_1], account number is [ACCOUNT_1]");
        let args = messages[1]["tool_calls"][0]["function"]["arguments"].as_str().unwrap();
        assert_eq!(args, r#"{"label":"Recipient:\n[ADDRESS_1]"}"#);
        let result = messages[2]["content"].as_str().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(result).expect("still JSON"),
            json!({ "note": "Hi,\n[PERSON_1]", "from": "From:\n[EMAIL_1]", "account": "[ACCOUNT_1]" })
        );
        assert_eq!(messages[3]["content"][0]["text"], r#"{"to":"[ADDRESS_1]"}"#);
        // The email after `From:\n`, not `nbob@posteo.de`.
        assert_eq!(vault.restore("[EMAIL_1]"), "bob@posteo.de");
        assert_eq!(vault.found(), BTreeMap::from([("ACCOUNT", 1), ("ADDRESS", 1), ("EMAIL", 1), ("PERSON", 1)]));
        assert_eq!(vault.restore_json(args), label);

        // Text that is not JSON: an escape before a value is a word boundary there too, and what
        // detection finds after one starts after it.
        let text = r#"Result: {"label":"Recipient:\nHauptstraße 12a,\n10115 Berlin","note":"Hi,\nHannah Weber","from":"From:\ncarol@posteo.de"}"#;
        let mut vault = vault;
        let redacted = vault.redact(text);
        assert_eq!(
            redacted,
            r#"Result: {"label":"Recipient:\n[ADDRESS_1]","note":"Hi,\n[PERSON_1]","from":"From:\n[EMAIL_2]"}"#
        );
        assert_eq!(vault.restore("[EMAIL_2]"), "carol@posteo.de");
        assert_eq!(vault.restore_json(&redacted), text);
        // An escaped backslash before an `n` is a backslash and a letter.
        assert_eq!(vault.redact(r"C:\\nHannah Weber"), r"C:\\nHannah [PERSON_2]");
    }

    #[test]
    fn a_value_beside_a_letter_of_another_script_is_hidden_and_counted() {
        let mut body = json!({ "messages": [
            { "role": "user", "content": "My number is +49 171 2345678, account number is 12345678" },
            // JSON as Python's json.dumps writes it, non-ASCII escaped: "+49 171 2345678로 전화".
            { "role": "tool", "tool_call_id": "c1", "content": r#"{"m":"+49 171 2345678\ub85c \uc804\ud654"}"# },
            // JSON lines are not one JSON document: they are read as text.
            { "role": "tool", "tool_call_id": "c2", "content": concat!(
                r#"{"ok":1}"#, "\n", r#"{"m":"010-1234-5678\uc73c\ub85c"}"#, "\n",
                r#"{"m":"\u30e1\u30fc\u30eb\u306fbob@posteo.de\u307e\u3067"}"#
            ) },
            { "role": "user", "content": "010-1234-5678으로 연락주세요" },
            { "role": "user", "content": "카드 4111 1111 1111 1111로, 12345678번 계좌" }
        ] });
        let vault = redact_request(&mut body);
        let messages = &body["messages"];
        assert_eq!(messages[0]["content"], "My number is [PHONE_1], account number is [ACCOUNT_1]");
        assert_eq!(messages[1]["content"], r#"{"m":"[PHONE_1]로 전화"}"#);
        assert_eq!(
            messages[2]["content"],
            concat!(
                r#"{"ok":1}"#,
                "\n",
                r#"{"m":"[PHONE_2]\uc73c\ub85c"}"#,
                "\n",
                r#"{"m":"\u30e1\u30fc\u30eb\u306f[EMAIL_1]\u307e\u3067"}"#
            )
        );
        assert_eq!(messages[3]["content"], "[PHONE_2]으로 연락주세요");
        assert_eq!(messages[4]["content"], "카드 [CARD_1]로, [ACCOUNT_1]번 계좌");
        assert_eq!(vault.restore("[PHONE_2] [EMAIL_1]"), "010-1234-5678 bob@posteo.de");
        assert_eq!(vault.found(), BTreeMap::from([("ACCOUNT", 1), ("CARD", 1), ("EMAIL", 1), ("PHONE", 2)]));
    }

    #[test]
    fn a_known_number_after_an_escape_that_ends_in_a_digit_is_hidden_and_counted() {
        let mut body = json!({ "messages": [
            { "role": "user", "content": "My number is 010-1234-5678, card 4111 1111 1111 1111, account number is 12345678" },
            // JSON lines from Python's json.dumps: "전화번호01012345678", "카드번호4111111111111111",
            // "계좌번호1234-5678", "계좌 번호 1234 5678". The `\ud638` of 호 ends in hex digits that a
            // number would read on.
            { "role": "tool", "tool_call_id": "c1", "content": concat!(
                r#"{"ok":1}"#, "\n",
                r#"{"m":"\uc804\ud654\ubc88\ud63801012345678"}"#, "\n",
                r#"{"m":"\uce74\ub4dc\ubc88\ud6384111111111111111"}"#, "\n",
                r#"{"m":"\uacc4\uc88c\ubc88\ud6381234-5678"}"#, "\n",
                r#"{"m":"\uacc4\uc88c \ubc88\ud638 1234 5678"}"#
            ) }
        ] });
        let vault = redact_request(&mut body);
        assert_eq!(
            body["messages"][1]["content"],
            concat!(
                r#"{"ok":1}"#,
                "\n",
                r#"{"m":"\uc804\ud654\ubc88\ud638[PHONE_1]"}"#,
                "\n",
                r#"{"m":"\uce74\ub4dc\ubc88\ud638[CARD_1]"}"#,
                "\n",
                r#"{"m":"\uacc4\uc88c\ubc88\ud638[ACCOUNT_1]"}"#,
                "\n",
                r#"{"m":"\uacc4\uc88c \ubc88\ud638 [ACCOUNT_1]"}"#
            )
        );
        assert_eq!(vault.found(), BTreeMap::from([("ACCOUNT", 1), ("CARD", 1), ("PHONE", 1)]));
    }

    #[test]
    fn names_and_addresses_are_still_hidden_only_as_whole_words() {
        let mut vault = Vault::default();
        assert_eq!(vault.redact("I am Anna Berg, Via Roma 10"), "I am [PERSON_1], [ADDRESS_1]");
        // A Latin letter makes a longer word; a letter of a script without case does not.
        assert_eq!(
            vault.redact("Annabelle, Annaïs, Bergmann, Via Roma 10a; Anna와 Berg에게, Via Roma 10에서"),
            "Annabelle, Annaïs, Bergmann, Via Roma 10a; [PERSON_2]와 [PERSON_3]에게, [ADDRESS_1]에서"
        );
        assert_eq!(vault.found(), BTreeMap::from([("ADDRESS", 1), ("PERSON", 3)]));
    }

    #[test]
    fn a_known_name_is_a_whole_word_in_its_own_script() {
        let mut vault = Vault::default();
        assert_eq!(vault.redact("my friend Иван Петров"), "my friend [PERSON_1]");
        // A letter of its own script makes a longer word: a village, a park, a surname.
        let text = "Ивановка и Петровский парк, Иванов";
        assert_eq!(vault.redact(text), text);
        assert_eq!(vault.found(), BTreeMap::from([("PERSON", 1)]));

        let mut vault = Vault::default();
        assert_eq!(vault.redact("my friend Νίκος Παππάς"), "my friend [PERSON_1]");
        assert_eq!(vault.redact("Νίκοςς"), "Νίκοςς");
        assert_eq!(vault.found(), BTreeMap::from([("PERSON", 1)]));
    }

    #[test]
    fn later_mentions_of_a_known_value_are_hidden_as_words_of_their_own() {
        let mut vault = Vault::default();
        assert_eq!(vault.redact("my friend Иван Петров, +49 171 2345678"), "my friend [PERSON_1], [PHONE_1]");
        // In a later text: a number with other spacing, a name with a word of a script without
        // case right after it.
        assert_eq!(
            vault.redact("Иван Петров: +49-171-2345678, Иванに, Петров에게"),
            "[PERSON_1]: [PHONE_1], [PERSON_2]に, [PERSON_3]에게"
        );
        // Not inside a longer word of its script, inflected, or in code.
        let text = "Ивановка, Ивана и Петрова, `Иван Петров`";
        assert_eq!(vault.redact(text), text);
        assert_eq!(vault.found(), BTreeMap::from([("PERSON", 3), ("PHONE", 1)]));
    }

    #[test]
    fn a_known_number_may_be_split_by_one_space_of_any_width() {
        let mut vault = Vault::default();
        assert_eq!(
            vault.redact("I am Anna Berg, call +49 171 2345678, card 4111 1111 1111 1111"),
            "I am [PERSON_1], call [PHONE_1], card [CARD_1]"
        );
        // A no-break or narrow no-break space, as web pages, office documents and contacts write it.
        assert_eq!(
            vault.redact("+49\u{a0}171\u{a0}2345678, 4111\u{202f}1111\u{202f}1111\u{202f}1111"),
            "[PHONE_1], [CARD_1]"
        );
        // After a `\uXXXX` escape (`호`), the space stays in the text.
        assert_eq!(vault.redact("\\ud638\u{a0}4111111111111111"), "\\ud638\u{a0}[CARD_1]");
        // As the README says: not two spaces, a tab or a line break, and a name only with the same
        // capitals.
        let text = "+49  171  2345678, 4111\t1111\t1111\t1111, 4111\n1111\n1111\n1111, ANNA BERG, anna berg";
        assert_eq!(vault.redact(text), text);
        assert_eq!(vault.found(), BTreeMap::from([("CARD", 1), ("PERSON", 1), ("PHONE", 1)]));
    }

    #[test]
    fn what_was_found_is_hidden_where_it_was_found() {
        let mut vault = Vault::default();
        // The account rule reads on after `is`, where the number is not a whole word.
        assert_eq!(vault.redact("My account number is12345678."), "My account number is[ACCOUNT_1].");
        // The address rule finds `Weber Straße 5`, which the known `Hannah Weber` overlaps.
        assert_eq!(
            vault.redact("I am Hannah Weber. Ship to Hannah Weber Straße 5"),
            "I am [PERSON_1]. Ship to [PERSON_2] [ADDRESS_1]"
        );
        assert_eq!(vault.restore("[PERSON_2] [ADDRESS_1]"), "Hannah Weber Straße 5");
        assert_eq!(vault.found(), BTreeMap::from([("ACCOUNT", 1), ("ADDRESS", 1), ("PERSON", 2)]));

        // The listed-name rule finds `Hannah Lisa` inside the known `Hannah Lisa Weber`: it is
        // hidden with it, and not counted as a value of its own.
        let mut vault = Vault::default();
        assert_eq!(vault.redact("my sister Hannah Lisa Weber"), "my sister [PERSON_1]");
        assert_eq!(vault.redact("Hannah Lisa Weber called"), "[PERSON_1] called");
        assert_eq!(vault.found(), BTreeMap::from([("PERSON", 1)]));
    }

    #[test]
    fn a_value_found_across_a_json_escape_comes_back_as_written_and_reads_as_it_did() {
        // A tool result that is not one JSON document is read as text, as written: its `\n` is a
        // line break in the JSON it holds.
        let mut body = json!({ "messages": [
            { "role": "tool", "tool_call_id": "c1", "content": r#"Order 7: {"to":"Hauptstraße 12a,\n10115 Berlin"}"# }
        ] });
        let vault = redact_request(&mut body);
        assert_eq!(body["messages"][0]["content"], r#"Order 7: {"to":"[ADDRESS_1]"}"#);
        let mut answer = json!({ "choices": [{ "message": {
            "content": "It goes to [ADDRESS_1].",
            "tool_calls": [{ "function": { "name": "label", "arguments": r#"{"to":"[ADDRESS_1]"}"# } }]
        } }] });
        restore_response(&vault, &mut answer);
        let message = &answer["choices"][0]["message"];
        // Into text as it was written; into a tool call as what it stood for, a line break.
        assert_eq!(message["content"], r"It goes to Hauptstraße 12a,\n10115 Berlin.");
        let args = message["tool_calls"][0]["function"]["arguments"].as_str().unwrap();
        assert_eq!(args, r#"{"to":"Hauptstraße 12a,\n10115 Berlin"}"#);
        let parsed: serde_json::Value = serde_json::from_str(args).expect("valid JSON");
        assert_eq!(parsed["to"], "Hauptstraße 12a,\n10115 Berlin");
        assert_eq!(vault.restore_json("%5BADDRESS_1%5D"), "Hauptstra%C3%9Fe%2012a%2C%0A10115%20Berlin");
        assert_eq!(vault.restore("%5BADDRESS_1%5D"), "Hauptstra%C3%9Fe%2012a%2C%5Cn10115%20Berlin");

        // The same when streamed.
        let mut restorer = StreamRestorer::new(vault);
        let mut out = Vec::new();
        for event in [
            sse(json!({ "content": "It goes to [ADDR" })),
            sse(
                json!({ "content": "ESS_1].", "tool_calls": [{ "index": 0, "function": { "arguments": "{\"to\":\"[ADD" } }] }),
            ),
            sse(json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "RESS_1]\"}" } }] })),
        ] {
            out.extend(restorer.push(event.as_bytes()));
        }
        out.extend(restorer.push(b"data: [DONE]\n\n"));
        out.extend(restorer.finish());
        let (content, _, _, calls) = channels_of(&out);
        assert_eq!(content, r"It goes to Hauptstraße 12a,\n10115 Berlin.");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&calls[&0]).unwrap()["to"],
            "Hauptstraße 12a,\n10115 Berlin"
        );
    }

    #[test]
    fn a_value_written_escaped_and_unescaped_is_one() {
        let address = "Hauptstraße 12a,\n10115 Berlin";
        let lines = concat!(r#"{"ok":1}"#, "\n", r#"{"to":"Hauptstraße 12a,\n10115 Berlin"}"#);
        let document = json!({ "shipped_to": address }).to_string();
        // Found in JSON lines first, then in a JSON document and in a message.
        let mut body = json!({ "messages": [
            { "role": "tool", "tool_call_id": "c1", "content": lines },
            { "role": "tool", "tool_call_id": "c2", "content": document },
            { "role": "user", "content": format!("Ship to {address} please") }
        ] });
        let vault = redact_request(&mut body);
        let messages = &body["messages"];
        assert_eq!(messages[0]["content"], concat!(r#"{"ok":1}"#, "\n", r#"{"to":"[ADDRESS_1]"}"#));
        assert_eq!(messages[1]["content"], r#"{"shipped_to":"[ADDRESS_1]"}"#);
        assert_eq!(messages[2]["content"], "Ship to [ADDRESS_1] please");
        assert_eq!(vault.found(), BTreeMap::from([("ADDRESS", 1)]));
        // As it was first written.
        assert_eq!(vault.restore("[ADDRESS_1]"), r"Hauptstraße 12a,\n10115 Berlin");
        assert_eq!(vault.restore_json("[ADDRESS_1]"), r"Hauptstraße 12a,\n10115 Berlin");

        // The other way round: found in a JSON document first.
        let mut body = json!({ "messages": [
            { "role": "tool", "tool_call_id": "c1", "content": document },
            { "role": "tool", "tool_call_id": "c2", "content": lines }
        ] });
        let vault = redact_request(&mut body);
        assert_eq!(body["messages"][1]["content"], concat!(r#"{"ok":1}"#, "\n", r#"{"to":"[ADDRESS_1]"}"#));
        assert_eq!(vault.found(), BTreeMap::from([("ADDRESS", 1)]));
        assert_eq!(vault.restore("[ADDRESS_1]"), address);
        assert_eq!(vault.restore_json("[ADDRESS_1]"), r"Hauptstraße 12a,\n10115 Berlin");

        // The same characters written in a message first (code outside backticks): a backslash and
        // an `n`, in a tool call too.
        let code = r#"addr = "Hauptstraße 12a,\n10115 Berlin""#;
        let mut body = json!({ "messages": [
            { "role": "user", "content": code },
            { "role": "tool", "tool_call_id": "c1", "content": lines }
        ] });
        let vault = redact_request(&mut body);
        assert_eq!(body["messages"][1]["content"], concat!(r#"{"ok":1}"#, "\n", r#"{"to":"[ADDRESS_1]"}"#));
        assert_eq!(vault.found(), BTreeMap::from([("ADDRESS", 1)]));
        assert_eq!(vault.restore("[ADDRESS_1]"), r"Hauptstraße 12a,\n10115 Berlin");
        assert_eq!(vault.restore_json("[ADDRESS_1]"), r"Hauptstraße 12a,\\n10115 Berlin");
    }

    #[test]
    fn a_value_comes_back_exactly_as_it_was_written() {
        // Code in a message: the `\n` in its string is a backslash and an `n`, not a line break.
        let text = r#"addr = "Hauptstraße 12a,\n10115 Berlin""#;
        let mut body = json!({ "messages": [{ "role": "user", "content": text }] });
        let vault = redact_request(&mut body);
        assert_eq!(body["messages"][0]["content"], r#"addr = "[ADDRESS_1]""#);
        let mut answer = json!({ "choices": [{ "message": {
            "content": r#"addr = "[ADDRESS_1]""#,
            "tool_calls": [{ "function": { "name": "write", "arguments": r#"{"code":"addr = \"[ADDRESS_1]\""}"# } }]
        } }] });
        restore_response(&vault, &mut answer);
        let message = &answer["choices"][0]["message"];
        assert_eq!(message["content"], text);
        let args = message["tool_calls"][0]["function"]["arguments"].as_str().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(args).expect("valid JSON");
        assert_eq!(parsed["code"], text);
    }

    #[test]
    fn a_json_text_in_a_string_of_a_tool_result_is_read_as_json() {
        // An MCP tool's result passed on as text: a JSON document whose string holds JSON text.
        let address = "Hauptstraße 12a,\n10115 Berlin";
        let inner = json!({ "to": address }).to_string();
        let content = json!([{ "type": "text", "text": inner }]).to_string();
        let hidden = json!([{ "type": "text", "text": r#"{"to":"[ADDRESS_1]"}"# }]).to_string();
        let mut body = json!({ "messages": [{ "role": "tool", "tool_call_id": "c1", "content": content }] });
        let vault = redact_request(&mut body);
        assert_eq!(body["messages"][0]["content"], hidden);
        let mut answer = json!({ "choices": [{ "message": {
            "content": "It goes to [ADDRESS_1].",
            "tool_calls": [{ "function": { "name": "label", "arguments": r#"{"to":"[ADDRESS_1]"}"# } }]
        } }] });
        restore_response(&vault, &mut answer);
        let message = &answer["choices"][0]["message"];
        // What its `\n` stands for, a line break, in the tool call and in the text.
        let args = message["tool_calls"][0]["function"]["arguments"].as_str().unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(args).expect("valid JSON")["to"], address);
        assert_eq!(message["content"], format!("It goes to {address}."));

        // Its letters escaped too (`ß` as `\u00df`, as Python's `json.dumps` writes it), and
        // then in a message: one value.
        let ascii = json!([{ "type": "text", "text": inner.replace('ß', r"\u00df") }]).to_string();
        let mut body = json!({ "messages": [
            { "role": "tool", "tool_call_id": "c1", "content": content },
            { "role": "tool", "tool_call_id": "c2", "content": ascii },
            { "role": "user", "content": format!("Ship to {address} please") }
        ] });
        let vault = redact_request(&mut body);
        assert_eq!(body["messages"][0]["content"], hidden);
        assert_eq!(body["messages"][1]["content"], hidden);
        assert_eq!(body["messages"][2]["content"], "Ship to [ADDRESS_1] please");
        assert_eq!(vault.found(), BTreeMap::from([("ADDRESS", 1)]));
    }

    #[test]
    fn code_in_a_string_of_a_tool_result_reaches_a_tool_as_code() {
        // A file read whole: its text is not JSON, and the `\n` in its string is a backslash and
        // an `n`.
        let code = r#"addr = "Hauptstraße 12a,\n10115 Berlin""#;
        let mut body = json!({ "messages": [
            { "role": "tool", "tool_call_id": "c1", "content": json!({ "content": code }).to_string() }
        ] });
        let vault = redact_request(&mut body);
        assert_eq!(body["messages"][0]["content"], json!({ "content": r#"addr = "[ADDRESS_1]""# }).to_string());
        let mut answer = json!({ "choices": [{ "message": {
            "content": r#"addr = "[ADDRESS_1]""#,
            "tool_calls": [{ "function": { "name": "write", "arguments": r#"{"code":"addr = \"[ADDRESS_1]\""}"# } }]
        } }] });
        restore_response(&vault, &mut answer);
        let message = &answer["choices"][0]["message"];
        assert_eq!(message["content"], code);
        let args = message["tool_calls"][0]["function"]["arguments"].as_str().unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(args).expect("valid JSON")["code"], code);
    }

    #[test]
    fn json_text_with_a_lone_surrogate_is_read_as_text() {
        // `\ud800` is not a character: JSON text holding it is redacted as text, at the top or
        // inside a string.
        let mut vault = Vault::default();
        assert_eq!(vault.redact_json(r#"{"a":"\ud800 bob@posteo.de"}"#), r#"{"a":"\ud800 [EMAIL_1]"}"#);
        let inner = json!({ "t": r#"{"a":"\ud800 bob@posteo.de"}"# }).to_string();
        assert_eq!(vault.redact_json(&inner), json!({ "t": r#"{"a":"\ud800 [EMAIL_1]"}"# }).to_string());
    }

    #[test]
    fn a_link_ends_at_a_json_escape_in_text_that_is_not_json() {
        let mut vault = Vault::default();
        assert_eq!(vault.redact("My friend Zork Blax"), "My friend [PERSON_1]");
        assert_eq!(
            vault.redact(r"GET https://api.example.org/x\nZork Blax called"),
            r"GET https://api.example.org/x\n[PERSON_1] called"
        );
    }

    #[test]
    fn json_escapes_are_read_as_what_they_stand_for() {
        use super::{Kind, bounded, escape_at, spaced};
        let text = r#"a\nb\\nc\u00e9d\u000ae\ud83d\"f"#;
        assert_eq!(escape_at(text, 1), Some(('\n', 2)));
        assert_eq!(escape_at(text, 4), None);
        assert_eq!(escape_at(text, 5), None);
        assert_eq!(escape_at(text, 8), Some(('é', 6)));
        assert_eq!(escape_at(text, 15), Some(('\n', 6)));
        assert_eq!(escape_at(text, 22), Some((char::REPLACEMENT_CHARACTER, 6)));
        assert_eq!(escape_at(r"\uzzzz", 0), None);
        // `b` follows a line break; `c` an escaped backslash and an `n`; `d` an `é`.
        assert!(bounded(text, 3, 4, Kind::Person));
        assert!(!bounded(text, 7, 8, Kind::Person));
        assert!(!bounded(text, 14, 15, Kind::Person));
        assert!(bounded(text, 21, 22, Kind::Person));
        let spaced = spaced(text);
        assert_eq!(spaced.len(), text.len());
        assert_eq!(spaced, "a \nb\\\\nc\\u00e9d     \ne      \\\"f");
    }

    #[test]
    fn a_run_of_backslashes_is_read_once() {
        use super::spaced;
        // Pairs are kept as written; only an odd one out at the end of a run escapes what follows.
        assert_eq!(spaced(r"a\\\nb"), "a\\\\ \nb");
        assert_eq!(spaced(r"a\\\\nb"), r"a\\\\nb");
        // A request can hold a run as long as its body. Reading it takes time in its length, not
        // its square: a million backslashes took minutes when each pair recounted the run.
        let text = format!("{}n mail erin@posteo.de", "\\".repeat(1_000_001));
        let started = std::time::Instant::now();
        let read = spaced(&text);
        assert_eq!(read.len(), text.len());
        assert!(read.ends_with(" \n mail erin@posteo.de"));
        let mut vault = Vault::default();
        let redacted = vault.redact(&text);
        assert!(redacted.ends_with("n mail [EMAIL_1]"), "{}", &redacted[redacted.len() - 40..]);
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "{:?}", started.elapsed());
    }

    #[test]
    fn tool_descriptions_name_no_one() {
        let mut body = json!({
            "tools": [{ "type": "function", "function": {
                "name": "file",
                "description": "Create a new file called Report. My name is Weather Bot.\nHi Claude, mail erin@posteo.de",
                "parameters": { "type": "object", "properties": {
                    "to": { "type": "string", "description": "Hauptstraße 12a, 10115 Berlin, or Hannah Weber, +49 171 2345678" }
                } }
            } }],
            "messages": [{ "role": "user", "content": "Make the Report, Claude. I am Hannah Weber." }]
        });
        let vault = redact_request(&mut body);
        let function = &body["tools"][0]["function"];
        // Only what is found without guessing at words: no Report, Weather Bot or Claude.
        assert_eq!(
            function["description"],
            "Create a new file called Report. My name is Weather Bot.\nHi Claude, mail [EMAIL_1]"
        );
        assert_eq!(body["messages"][0]["content"], "Make the Report, Claude. I am [PERSON_1].");
        // A name the user's own messages gave is hidden in the descriptions too, though they come first.
        assert_eq!(
            function["parameters"]["properties"]["to"]["description"],
            "Hauptstraße 12a, 10115 Berlin, or [PERSON_1], [PHONE_1]"
        );
        assert_eq!(vault.found(), BTreeMap::from([("EMAIL", 1), ("PERSON", 1), ("PHONE", 1)]));
    }

    #[test]
    fn a_value_the_request_does_not_show_is_not_counted() {
        // The description's first pass hides the known `Hannah`; its second hides the longer
        // `Hannah Weberling` the message brought instead.
        let mut body = json!({
            "user": "my friend Hannah Weber",
            "tools": [{ "type": "function", "function": { "name": "ask", "description": "ask Hannah Weberling" } }],
            "messages": [{ "role": "user", "content": "my colleague Hannah Weberling" }]
        });
        let vault = redact_request(&mut body);
        assert_eq!(body["user"], "my friend [PERSON_1]");
        assert_eq!(body["tools"][0]["function"]["description"], "ask [PERSON_3]");
        assert_eq!(body["messages"][0]["content"], "my colleague [PERSON_3]");
        assert_eq!(vault.found(), BTreeMap::from([("PERSON", 2)]));
        assert_eq!(vault.restore("[PERSON_1] [PERSON_2] [PERSON_3]"), "Hannah Weber [PERSON_2] Hannah Weberling");
    }

    #[test]
    fn requests_redact_the_user_tools_and_reasoning_in_order() {
        let mut body = json!({
            "user": "dora@posteo.de",
            "tools": [
                { "type": "function", "function": {
                    "name": "mail",
                    "description": "Mails as erin@posteo.de",
                    "parameters": { "type": "object", "properties": {
                        "to": { "type": "string", "description": "like fred@posteo.de", "enum": ["gina@posteo.de"] },
                        "description": { "type": "string", "description": "the property is called description" }
                    } }
                } },
                { "type": "web_search", "description": "not a function: hal@posteo.de" }
            ],
            "messages": [
                { "role": "assistant", "tool_calls": [{ "function": { "name": "mail", "arguments": "{\"to\":\"ivy@posteo.de\"}" } }],
                  "reasoning": "jan@posteo.de", "reasoning_content": "kim@posteo.de", "content": "dora@posteo.de" }
            ]
        });
        let vault = redact_request(&mut body);
        assert_eq!(body["user"], "[EMAIL_1]");
        let function = &body["tools"][0]["function"];
        assert_eq!(function["description"], "Mails as [EMAIL_2]");
        assert_eq!(function["parameters"]["properties"]["to"]["description"], "like [EMAIL_3]");
        // Only descriptions: what a parameter may be is the client's to decide.
        assert_eq!(function["parameters"]["properties"]["to"]["enum"][0], "gina@posteo.de");
        assert_eq!(function["parameters"]["properties"]["description"]["type"], "string");
        assert_eq!(body["tools"][1]["description"], "not a function: hal@posteo.de");
        let message = &body["messages"][0];
        assert_eq!(message["content"], "[EMAIL_1]");
        assert_eq!(message["reasoning"], "[EMAIL_4]");
        assert_eq!(message["reasoning_content"], "[EMAIL_5]");
        assert_eq!(message["tool_calls"][0]["function"]["arguments"], r#"{"to":"[EMAIL_6]"}"#);
        assert_eq!(vault.found()["EMAIL"], 6);
    }

    #[test]
    fn a_usage_chunk_is_kept_back_only_when_asked() {
        // With usage asked for, the other chunks say `"usage": null`.
        let events = format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            json!({ "choices": [{ "index": 0, "delta": { "content": "hi" } }], "usage": null }),
            json!({ "choices": [], "usage": { "prompt_tokens": 5, "completion_tokens": 1 } })
        );
        let usage = std::sync::Arc::new(std::sync::Mutex::new(None));
        let mut kept = StreamRestorer::new(Vault::default()).withholding_usage(usage.clone());
        let mut out = kept.push(events.as_bytes());
        out.extend(kept.finish());
        assert_eq!(
            String::from_utf8(out).unwrap(),
            format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({ "choices": [{ "index": 0, "delta": { "content": "hi" } }] })
            )
        );
        assert_eq!(*usage.lock().unwrap(), Some(json!({ "prompt_tokens": 5, "completion_tokens": 1 })));

        let mut passed = StreamRestorer::new(Vault::default());
        let mut out = passed.push(events.as_bytes());
        out.extend(passed.finish());
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains(r#""prompt_tokens":5"#) && out.contains(r#""usage":null"#), "{out}");
    }

    #[test]
    fn usage_on_the_last_chunk_is_kept_back_and_the_chunk_sent() {
        // As DeepSeek sends it: no chunk of its own, the usage rides with the finished choice.
        let usage = json!({ "prompt_tokens": 5, "completion_tokens": 2 });
        let events = format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            json!({ "choices": [{ "index": 0, "delta": { "content": "to [EMA" }, "finish_reason": null }], "usage": null }),
            json!({ "choices": [{ "index": 0, "delta": { "content": "IL_1]" }, "finish_reason": "stop" }], "usage": usage })
        );
        let vault = || {
            let mut vault = Vault::default();
            vault.redact("bob@posteo.de");
            vault
        };
        let into = std::sync::Arc::new(std::sync::Mutex::new(None));
        let mut kept = StreamRestorer::new(vault()).withholding_usage(into.clone());
        let mut out = kept.push(events.as_bytes());
        out.extend(kept.finish());
        assert_eq!(
            String::from_utf8(out).unwrap(),
            format!(
                "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                json!({ "choices": [{ "index": 0, "delta": { "content": "to " }, "finish_reason": null }] }),
                json!({ "choices": [{ "index": 0, "delta": { "content": "bob@posteo.de" }, "finish_reason": "stop" }] })
            )
        );
        assert_eq!(*into.lock().unwrap(), Some(usage.clone()));

        // The client asked for it: the chunks go as they came, restored.
        let mut passed = StreamRestorer::new(vault());
        let mut out = passed.push(events.as_bytes());
        out.extend(passed.finish());
        let out = String::from_utf8(out).unwrap();
        let last = json!({ "choices": [{ "index": 0, "delta": { "content": "bob@posteo.de" }, "finish_reason": "stop" }], "usage": usage });
        assert!(out.contains(&format!("data: {last}\n")) && out.contains(r#""usage":null"#), "{out}");
    }

    #[test]
    fn every_channel_restores_the_same_however_it_is_cut() {
        crate::testgen::cases("stream restore, every channel", |g| {
            // An address with a line break, which JSON escapes.
            let make = || {
                let mut vault = Vault::default();
                for known in ["bob@posteo.de", "call +44 20 7946 0958", "to Hauptstraße 12a,\n10115 Berlin"] {
                    vault.redact(known);
                }
                vault
            };
            let vault = make();
            // Each channel's whole text, cut anywhere (placeholders too: only `[` tails are held
            // back, so no percent-encoded ones), the pieces of the channels interleaved. A call's
            // arguments are JSON: one of those texts in a string.
            let mut pieces: Vec<&str> = PIECES.iter().copied().filter(|p| !p.contains('%')).collect();
            pieces.push("[ADDRESS_1]");
            let texts: Vec<String> = (0..5).map(|_| g.assemble(&pieces, 6)).collect();
            let wanted: Vec<String> = texts
                .iter()
                .enumerate()
                .map(|(channel, text)| if channel < 3 { text.clone() } else { json!({ "to": text }).to_string() })
                .collect();
            let mut cuts: Vec<std::collections::VecDeque<String>> = wanted
                .iter()
                .map(|text| {
                    let mut cut = std::collections::VecDeque::from([String::new()]);
                    for c in text.chars() {
                        if g.one_in(3) {
                            cut.push_back(String::new());
                        }
                        cut.back_mut().expect("one piece").push(c);
                    }
                    cut
                })
                .collect();
            let mut sse = Vec::new();
            loop {
                let open: Vec<usize> = (0..5).filter(|&c| !cuts[c].is_empty()).collect();
                if open.is_empty() {
                    break;
                }
                let channel = *g.pick(&open);
                let piece = cuts[channel].pop_front().expect("open");
                let delta = match channel {
                    0 => json!({ "content": piece }),
                    1 => json!({ "reasoning_content": piece }),
                    2 => json!({ "reasoning": piece }),
                    at => json!({ "tool_calls": [{ "index": at - 3, "function": { "arguments": piece } }] }),
                };
                sse.extend(super::tests::sse(delta).bytes());
            }
            if g.one_in(2) {
                sse.extend(
                    format!(
                        "data: {}\n\n",
                        json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] })
                    )
                    .bytes(),
                );
            }
            sse.extend(b"data: [DONE]\n\n");
            let mut r = StreamRestorer::new(make());
            let mut out = Vec::new();
            for part in g.split(&sse) {
                out.extend(r.push(part));
            }
            out.extend(r.finish());
            let (content, reasoning_content, reasoning, calls) = channels_of(&out);
            assert_eq!(content, vault.restore(&wanted[0]));
            assert_eq!(reasoning_content, vault.restore(&wanted[1]));
            assert_eq!(reasoning, vault.restore(&wanted[2]));
            for at in 0..2 {
                let args = calls.get(&at).map_or("", String::as_str);
                assert_eq!(args, vault.restore_json(&wanted[3 + at as usize]), "call {at}");
                // Put back together, the arguments are JSON again and hold the real values.
                let parsed: serde_json::Value =
                    serde_json::from_str(args).unwrap_or_else(|e| panic!("call {at}: {e} in {args:?}"));
                assert_eq!(parsed["to"], vault.restore(&texts[3 + at as usize]), "call {at}");
            }
        });
    }

    #[test]
    fn any_request_body_is_redacted_without_panicking() {
        crate::testgen::cases("redact_request", |g| {
            let content = g.assemble(PIECES, 30);
            let mut body = if g.one_in(2) {
                json!({ "messages": [{ "role": "user", "content": content }] })
            } else {
                json!({ "messages": [{ "role": "user", "content": [{ "type": "text", "text": content }, { "type": "image_url" }] }], "system": g.text(20) })
            };
            let vault = redact_request(&mut body);

            restore_response(&vault, &mut json!({ "choices": [{ "message": { "content": body.to_string() } }] }));
        });
    }
}
