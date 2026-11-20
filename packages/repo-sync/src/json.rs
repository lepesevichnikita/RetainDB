//! Minimal JSON reader/writer: the hook receives one JSON event on stdin and
//! the local state files are JSON, so the crate needs both directions without
//! pulling a serde dependency.
//!
//! Scope is deliberately small: one value per document, no duplicate-key
//! merging, nesting capped at [`MAX_DEPTH`]. Anything outside that is a
//! malformed event and the caller fails open.

use std::fmt;

/// Nesting limit; hook payloads are shallow, deeper input is hostile.
pub const MAX_DEPTH: u32 = 32;

/// A parsed JSON value. Objects keep their key order so state files stay
/// byte-stable between runs.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

/// Parse failure with a human message; callers treat it as "malformed input".
#[derive(Clone, Debug, PartialEq)]
pub struct JsonError {
    pub message: String,
}

impl JsonError {
    fn at(pos: usize, message: &str) -> Self {
        Self {
            message: format!("{message} at byte {pos}"),
        }
    }
}

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid json: {}", self.message)
    }
}

impl std::error::Error for JsonError {}

impl Json {
    /// Field lookup on an object, `None` for any other shape.
    pub fn get(&self, key: &str) -> Option<&Json> {
        self.as_object()?
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    /// Borrow the object pairs.
    pub fn as_object(&self) -> Option<&[(String, Json)]> {
        match self {
            Self::Object(pairs) => Some(pairs),
            _ => None,
        }
    }

    /// String payload, if this is a string.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(text) => Some(text),
            _ => None,
        }
    }

    /// Non-negative integer payload, if this is an integral number.
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Self::Number(value) if *value >= 0.0 && value.fract() == 0.0 => Some(*value as u64),
            _ => None,
        }
    }

    /// Boolean payload.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(flag) => Some(*flag),
            _ => None,
        }
    }

    /// Serialise back to compact JSON.
    pub fn encode(&self) -> String {
        let mut out = String::new();
        write_value(self, &mut out);
        out
    }
}

impl From<&str> for Json {
    fn from(text: &str) -> Self {
        Self::String(text.to_string())
    }
}

impl From<&String> for Json {
    fn from(text: &String) -> Self {
        Self::String(text.clone())
    }
}

impl From<u64> for Json {
    fn from(value: u64) -> Self {
        Self::Number(value as f64)
    }
}

impl From<bool> for Json {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

impl From<Option<&str>> for Json {
    fn from(value: Option<&str>) -> Self {
        match value {
            Some(text) => Self::String(text.to_string()),
            None => Self::Null,
        }
    }
}

/// Build an object from `(&str, Json)` pairs.
pub fn object<const N: usize>(pairs: [(&str, Json); N]) -> Json {
    Json::Object(
        pairs
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

/// Parse exactly one JSON value, rejecting trailing garbage.
pub fn parse(input: &str) -> Result<Json, JsonError> {
    let mut reader = Reader {
        bytes: input.as_bytes(),
        pos: 0,
    };
    reader.skip_whitespace();
    let value = reader.value(0)?;
    reader.skip_whitespace();
    if reader.pos != reader.bytes.len() {
        return Err(JsonError::at(reader.pos, "trailing input"));
    }
    Ok(value)
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn value(&mut self, depth: u32) -> Result<Json, JsonError> {
        if depth > MAX_DEPTH {
            return Err(JsonError::at(self.pos, "nesting too deep"));
        }
        match self.peek() {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => self.string().map(Json::String),
            Some(b't') => self.literal("true", Json::Bool(true)),
            Some(b'f') => self.literal("false", Json::Bool(false)),
            Some(b'n') => self.literal("null", Json::Null),
            Some(byte) if byte == b'-' || byte.is_ascii_digit() => self.number(),
            _ => Err(JsonError::at(self.pos, "expected a value")),
        }
    }

    fn literal(&mut self, word: &str, value: Json) -> Result<Json, JsonError> {
        let end = self.pos + word.len();
        if self.bytes.get(self.pos..end) != Some(word.as_bytes()) {
            return Err(JsonError::at(self.pos, "expected literal"));
        }
        self.pos = end;
        Ok(value)
    }

    fn object(&mut self, depth: u32) -> Result<Json, JsonError> {
        self.pos += 1;
        let mut pairs = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Json::Object(pairs));
        }
        loop {
            self.skip_whitespace();
            let key = self.member_key()?;
            self.skip_whitespace();
            if self.peek() != Some(b':') {
                return Err(JsonError::at(self.pos, "expected ':'"));
            }
            self.pos += 1;
            self.skip_whitespace();
            let value = self.value(depth + 1)?;
            pairs.push((key, value));
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Json::Object(pairs));
                }
                _ => return Err(JsonError::at(self.pos, "expected ',' or '}'")),
            }
        }
    }

    fn member_key(&mut self) -> Result<String, JsonError> {
        if self.peek() != Some(b'"') {
            return Err(JsonError::at(self.pos, "expected an object key"));
        }
        self.string()
    }

    fn array(&mut self, depth: u32) -> Result<Json, JsonError> {
        self.pos += 1;
        let mut items = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Json::Array(items));
        }
        loop {
            self.skip_whitespace();
            items.push(self.value(depth + 1)?);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Json::Array(items));
                }
                _ => return Err(JsonError::at(self.pos, "expected ',' or ']'")),
            }
        }
    }

    fn number(&mut self) -> Result<Json, JsonError> {
        let start = self.pos;
        while matches!(
            self.peek(),
            Some(b'-' | b'+' | b'.' | b'e' | b'E') | Some(b'0'..=b'9')
        ) {
            self.pos += 1;
        }
        let text = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| JsonError::at(start, "bad number"))?;
        text.parse::<f64>()
            .map(Json::Number)
            .map_err(|_| JsonError::at(start, "bad number"))
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.pos += 1;
        let mut out = String::new();
        loop {
            match self.peek() {
                None => return Err(JsonError::at(self.pos, "unterminated string")),
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b'\\') => self.pos += 1,
                Some(byte) if byte < 0x20 => {
                    return Err(JsonError::at(self.pos, "control character in string"))
                }
                Some(_) => {
                    out.push(self.next_char()?);
                    continue;
                }
            }
            let escape = self.bytes.get(self.pos).copied();
            self.pos += 1;
            out.push(self.escaped_char(escape)?);
        }
    }

    /// Decode one UTF-8 character at the cursor.
    ///
    /// A character is at most four bytes; decoding incrementally keeps string
    /// parsing linear even for a 64 KiB event made of one long string.
    fn next_char(&mut self) -> Result<char, JsonError> {
        let rest = &self.bytes[self.pos..];
        for len in 1..=rest.len().min(4) {
            if let Ok(text) = std::str::from_utf8(&rest[..len]) {
                if let Some(ch) = text.chars().next().filter(|ch| ch.len_utf8() == len) {
                    self.pos += len;
                    return Ok(ch);
                }
            }
        }
        Err(JsonError::at(self.pos, "invalid utf-8"))
    }

    fn escaped_char(&mut self, escape: Option<u8>) -> Result<char, JsonError> {
        let simple = match escape {
            Some(b'"') => Some('"'),
            Some(b'\\') => Some('\\'),
            Some(b'/') => Some('/'),
            Some(b'b') => Some('\u{8}'),
            Some(b'f') => Some('\u{c}'),
            Some(b'n') => Some('\n'),
            Some(b'r') => Some('\r'),
            Some(b't') => Some('\t'),
            Some(b'u') => None,
            _ => return Err(JsonError::at(self.pos, "bad escape")),
        };
        if let Some(ch) = simple {
            return Ok(ch);
        }
        let high = self.hex4()?;
        if !(0xD800..0xDC00).contains(&high) {
            return char::from_u32(high).ok_or_else(|| JsonError::at(self.pos, "bad escape"));
        }
        let combined = self.low_surrogate(high)?;
        char::from_u32(combined).ok_or_else(|| JsonError::at(self.pos, "bad escape"))
    }

    /// Read the `\uXXXX` low half of a surrogate pair.
    fn low_surrogate(&mut self, high: u32) -> Result<u32, JsonError> {
        if self.bytes.get(self.pos..self.pos + 2) != Some(b"\\u") {
            return Err(JsonError::at(self.pos, "unpaired surrogate"));
        }
        self.pos += 2;
        let low = self.hex4()?;
        if !(0xDC00..0xE000).contains(&low) {
            return Err(JsonError::at(self.pos, "unpaired surrogate"));
        }
        Ok(0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00))
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        let slice = self
            .bytes
            .get(self.pos..self.pos + 4)
            .ok_or_else(|| JsonError::at(self.pos, "short unicode escape"))?;
        let text = std::str::from_utf8(slice).map_err(|_| JsonError::at(self.pos, "bad escape"))?;
        let value =
            u32::from_str_radix(text, 16).map_err(|_| JsonError::at(self.pos, "bad escape"))?;
        self.pos += 4;
        Ok(value)
    }
}

fn write_value(value: &Json, out: &mut String) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(true) => out.push_str("true"),
        Json::Bool(false) => out.push_str("false"),
        Json::Number(number) => out.push_str(&encode_number(*number)),
        Json::String(text) => write_string(text, out),
        Json::Array(items) => write_array(items, out),
        Json::Object(pairs) => write_object(pairs, out),
    }
}

fn write_array(items: &[Json], out: &mut String) {
    out.push('[');
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_value(item, out);
    }
    out.push(']');
}

fn write_object(pairs: &[(String, Json)], out: &mut String) {
    out.push('{');
    for (index, (key, item)) in pairs.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_string(key, out);
        out.push(':');
        write_value(item, out);
    }
    out.push('}');
}

fn encode_number(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 9e15 {
        format!("{}", number as i64)
    } else {
        format!("{number}")
    }
}

fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
}
