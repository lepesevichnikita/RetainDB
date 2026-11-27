/** Redact recognized credentials and their echoes across a complete capture event.
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactCapture(value) {
  const secrets = new Set();
  function remember(entry) {
    if (typeof entry === "string" && entry && entry !== "[REDACTED]") {
      secrets.add(entry);
      secrets.add(JSON.stringify(entry).slice(1, -1));
    } else if (typeof entry === "number" || typeof entry === "boolean") {
      remember(String(entry));
    } else if (Array.isArray(entry)) {
      entry.forEach(remember);
    } else if (entry && typeof entry === "object") {
      Object.values(entry).forEach(remember);
    }
  }
  function sanitize(entry) {
    if (typeof entry === "string") {
      try {
        const parsed = JSON.parse(entry);
        if (parsed && typeof parsed === "object") return JSON.stringify(sanitize(parsed));
      } catch {}
      return entry
        .replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/g, (match, _kind, body) => {
          remember(match);
          String(body).trim().split(/\s+/).forEach(remember);
          return "[REDACTED]";
        })
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s"'?#]+)@/gi, (_match, scheme, userInfo) => {
          remember(userInfo);
          const separator = String(userInfo).indexOf(":");
          if (separator >= 0) {
            const password = String(userInfo).slice(separator + 1);
            remember(password);
            try { remember(decodeURIComponent(password)); } catch {}
          }
          return `${scheme}[REDACTED]@`;
        })
        .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, match => {
          remember(match);
          return "[REDACTED]";
        })
        .replace(/(\bBearer\s+)([A-Za-z0-9._~+\/-]+)/gi, (_match, prefix, credential) => {
          remember(credential);
          return `${prefix}[REDACTED]`;
        })
        .replace(/(["']?(?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|(?:access|refresh|auth)[_-]?token|token|secret(?:[_-]?access[_-]?key)?|password|private[_-]?key)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^"',\s}]+)/gi, (_match, prefix, credential) => {
          try {
            const parsed = JSON.parse(credential);
            remember(typeof parsed === "string" ? parsed : credential);
          }
          catch { remember(credential.startsWith("'") ? credential.slice(1, -1).replace(/\\(['\\])/g, "$1") : credential); }
          return `${prefix}[REDACTED]`;
        });
    }
    if (Array.isArray(entry)) return entry.map(sanitize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry).map(([key, item]) => {
        if (/(?:^|[_-])(?:authorization|api[_-]?key|(?:access|refresh|auth)[_-]?token|token|secret(?:[_-]?access[_-]?key)?|password|private[_-]?key)$/i.test(key)) {
          remember(item);
          sanitize(item);
          return [key, "[REDACTED]"];
        }
        return [key, sanitize(item)];
      }));
    }
    return entry;
  }
  const sanitized = sanitize(value);
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  function scrub(entry) {
    if (typeof entry === "string") {
      // A whole-value match is the only safe replacement for a one-character
      // secret ("1", "f"): it has no information value and appears in ordinary
      // prose, so replacing it inside a sentence corrupts the captured text.
      if (ordered.includes(entry)) return "[REDACTED]";
      return ordered.reduce((text, secret) => {
        if (secret.length >= 8) return text.split(secret).join("[REDACTED]");
        if (secret.length < 2) return text;
        // Two to seven characters are replaced as complete tokens, never inside a
        // word, so a short echo is removed without touching "fixture-project".
        const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return text.replace(new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}(?=$|[^\\p{L}\\p{N}_-])`, "gu"), "$1[REDACTED]");
      }, entry);
    }
    if ((typeof entry === "number" || typeof entry === "boolean") && secrets.has(String(entry))) return "[REDACTED]";
    if (Array.isArray(entry)) return entry.map(scrub);
    if (entry && typeof entry === "object") return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, scrub(item)]));
    return entry;
  }
  return scrub(sanitized);
}
