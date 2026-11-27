/**
 * ID patterns and the regexes built around them (docs/trackers.md, "What the loader refuses"): the grammar, the canonical
 * source (valid with and without the `u` flag), the bounds, every built regex, and the adversarial probe.
 * All trackers, hosts and IDs here are fictional.
 */
import { describe, expect, it } from "vitest";
import {
  buildTaskRefRegexes,
  checkUrlTemplate,
  escapeLiteral,
  firstGroup,
  idMatcher,
  MAX_BRANCH,
  MAX_SCAN_TEXT,
  parseIdPattern,
  parseUrlPattern,
  scanText,
  type IdPattern,
  type TaskRefInput,
} from "../src/trackers/config/patterns.ts";

function pattern(text: string): IdPattern {
  const parsed = parseIdPattern(text);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error}`);
  return parsed.value;
}

function url(text: string) {
  const parsed = parseUrlPattern(text);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error}`);
  return parsed.value;
}

/** Every match of a global regex, the way the tracker scans a text. */
function allMatches(re: RegExp, text: string): string[] {
  re.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(firstGroup(m) ?? "");
  return out;
}

describe("the ID pattern grammar", () => {
  it.each([
    ["[1-9]\\d{3,8}", "[1-9]\\d{3,8}", 4, 9],
    ["[1-9]\\d{0,11}", "[1-9]\\d{0,11}", 1, 12],
    ["ACME-[1-9]\\d{0,6}", "ACME-[1-9]\\d{0,6}", 6, 12],
    ["[A-Z][A-Z0-9]{1,9}-[1-9]\\d{0,6}", "[A-Z][A-Z0-9]{1,9}-[1-9]\\d{0,6}", 4, 18],
    ["[^\\s,]{1,64}", "[^\\s,]{1,64}", 1, 64],
    ["[A-Za-z0-9][A-Za-z0-9_-]{0,39}", "[A-Za-z0-9][A-Za-z0-9_\\-]{0,39}", 1, 40],
    ["\\d{4,12}", "\\d{4,12}", 4, 12],
    ["PROJ\\-\\d{1,5}", "PROJ-\\d{1,5}", 6, 10],
    ["v\\.\\d{1,3}", "v\\.\\d{1,3}", 3, 5],
    ["a\\/b\\#c\\:d", "a\\/b#c:d", 7, 7],
    ["[\\#\\:\\.\\/]", "[#:./]", 1, 1],
    ["[-a]", "[\\-a]", 1, 1],
    ["[a-]", "[a\\-]", 1, 1],
    ["[^-]", "[^\\-]", 1, 1],
    ["[\\[\\]\\\\]", "[\\[\\]\\\\]", 1, 1],
    ["[a^]", "[a\\^]", 1, 1],
    ["[$(){}|*+?]", "[$(){}|*+?]", 1, 1],
    ["x?y", "x?y", 1, 2],
    ["a{3}", "a{3}", 3, 3],
    ["a{2,2}", "a{2}", 2, 2],
    ["a{0,1}b", "a?b", 1, 2],
    ["a{1}", "a", 1, 1],
    ["a{1,1}", "a", 1, 1],
    ["[_]\\w\\s", "[_]\\w\\s", 3, 3],
  ])("accepts %s (canonical %s)", (input, source, minLength, maxLength) => {
    expect(parseIdPattern(input)).toEqual({ ok: true, value: { source, minLength, maxLength } });
  });

  it.each([
    ["", "is empty"],
    ["a".repeat(101), "longer than 100"],
    ["(a)", "groups and alternatives"],
    ["a|b", "groups and alternatives"],
    ["(?=a)b", "groups and alternatives"],
    ["^a", "anchors"],
    ["a$", "anchors"],
    ["a*", "isn't allowed: write {m,n}"],
    ["a+", "isn't allowed: write {m,n}"],
    ["a{2,}", "a repeat is written"],
    ["a{,2}", "a repeat is written"],
    ["a{1, 2}", "a repeat is written"],
    ["a{65}", "up to 64 at most"],
    ["a{3,2}", "m can't be more than n"],
    ["a??", "only one repeat"],
    ["a?{2}", "only one repeat"],
    ["?a", "nothing does"],
    ["{2}", "nothing does"],
    [".", "any character isn't allowed"],
    ["\\b1", "isn't allowed; the escapes"],
    ["\\1", "isn't allowed; the escapes"],
    ["\\D", "isn't allowed; the escapes"],
    ["\\u0041", "isn't allowed; the escapes"],
    ["\\", "isn't allowed; the escapes"],
    ["[]", "empty class"],
    ["[^]", "empty class"],
    ["[a", "isn't closed"],
    ["[a-Z]", "isn't a range"],
    ["[z-a]", "isn't a range"],
    ["[0-z]", "isn't a range"],
    ["[a-\\d]", "isn't a range"],
    ["[a-c-e]", "goes first or last"],
    ["[a[b]", "is written \\["],
    ["[\\b]", "isn't an escape a class can hold"],
    ["[a b]", "can't be in a class"],
    ["[é]", "can't be in a class"],
    ["a b", "isn't allowed"],
    ["é", "isn't allowed"],
    ["#1", "write \\#"],
    ["a:1", "write \\:"],
    ["a/1", "write \\/"],
    ["a{0}", "matches an empty ID"],
    ["a?", "matches an empty ID"],
    ["\\d{0,64}", "matches an empty ID"],
    ["\\d{1,64}x", "up to 65 characters"],
    ["\\d{33}\\d{32}", "up to 65 characters"],
    ["\\d?\\d?\\d?\\d?\\d?\\d?\\d?\\d?\\d?1", "too many ways to match (512"],
    ["\\d{1,17}\\d{1,16}", "too many ways to match (272"],
  ])("refuses %j", (input, error) => {
    const parsed = parseIdPattern(input);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toContain(error);
  });

  it.each([
    "\\d{2}\\s\\d{4}",
    "\\s{1,3}\\d{4}",
    "[\\d\\s]{3,9}",
    "[\\d/]{3,9}",
    "[\\d\\/]{3,9}",
    "\\d{3}\\/\\d{4}",
    "[^,]{1,9}", // can match a space and a "/"
    "[^\\s,]{1,64}", // leaves out whitespace, not "/"
    "[^/,]{1,9}", // leaves out "/", not whitespace
  ])("refuses %j for IDs found in text, where a cut at whitespace or / could shorten them", (input) => {
    const scanned = parseIdPattern(input, true);
    expect(scanned.ok).toBe(false);
    expect(scanned.ok ? "" : scanned.error).toContain("can match whitespace");
    // A whole-ID pattern (ids.*) may hold them: the grammar itself still accepts these.
    expect(parseIdPattern(input).ok).toBe(true);
  });

  it("allows IDs found in text that are one word", () => {
    for (const input of ["\\d{3,9}", "[1-9]\\d{3,8}", "ACME-[1-9]\\d{0,6}", "[\\w-]{1,9}", "[A-Za-z0-9._#:-]{1,20}", "[^\\s/,]{1,9}", "[^/\\s]{1,9}"]) {
      expect([input, parseIdPattern(input, true).ok]).toEqual([input, true]);
    }
  });

  it("allows up to 256 ways to match", () => {
    expect(parseIdPattern("\\d{1,16}\\d{1,16}x").ok).toBe(true);
    expect(parseIdPattern("\\d?\\d?\\d?\\d?\\d?\\d?\\d?\\d?1").ok).toBe(true);
  });

  it("writes a source that means the same with and without the u flag", () => {
    const samples = ["", "a", "A", "-", "_", "#", ":", ".", "/", "\\", "[", "]", "^", "$", " ", "\t", "é", "ſ", "K", "K", "0", "9", "12345", "ACME-12", "v.1", "a/b#c:d"];
    for (const input of ["[^\\s,]{1,64}", "[A-Za-z0-9_-]{1,9}", "[\\#\\:\\.\\/\\-]{1,3}", "[\\[\\]\\\\^]", "PROJ\\-\\d{1,5}", "a\\/b\\#c\\:d", "[$(){}|*+?.]{1,2}", "\\w{1,3}", "\\s"]) {
      const { source } = pattern(input);
      const plain = new RegExp(`^(?:${source})$`);
      const unicode = new RegExp(`^(?:${source})$`, "u");
      for (const sample of samples) expect([input, sample, unicode.test(sample)]).toEqual([input, sample, plain.test(sample)]);
    }
  });

  it("checks a whole ID, case-sensitively unless asked, without Unicode case folding", () => {
    const p = pattern("[a-z]{1,4}");
    expect(idMatcher(p, false).test("abc")).toBe(true);
    expect(idMatcher(p, false).test("ABC")).toBe(false);
    expect(idMatcher(p, false).test("abcde")).toBe(false);
    expect(idMatcher(p, true).test("ABC")).toBe(true);
    expect(idMatcher(p, true).test("ſ")).toBe(false);
    // The Kelvin sign and the long s: with the u flag, i would fold them to k and s.
    expect(idMatcher(pattern("\\w"), true).test("K")).toBe(false);
    expect(idMatcher(pattern("[a-z]"), true).test("ſ")).toBe(false);
    expect(new RegExp("^[a-z]$", "iu").test("K")).toBe(true);
  });
});

describe("URL patterns and the task link", () => {
  it.each([
    ["tracker.example/ticket/{id}", { before: "tracker.example/ticket/", after: "" }],
    ["tracker.example:8443/a/{id}/details", { before: "tracker.example:8443/a/", after: "/details" }],
    ["acme.example/browse/{id}", { before: "acme.example/browse/", after: "" }],
    ["acme.example/x-{id}.html", { before: "acme.example/x-", after: ".html" }],
  ])("reads %s", (input, value) => {
    expect(parseUrlPattern(input)).toEqual({ ok: true, value });
  });

  it.each([
    ["", "is empty"],
    ["https://acme.example/{id}", "starts with a scheme"],
    ["{id}.acme.example/x", "needs a host"],
    ["acme.example{id}", "needs a host"],
    ["acme.example/{id}/{id}", "exactly one {id}"],
    ["acme.example/x", "exactly one {id}"],
    ["acme.example/x y/{id}", "needs a host"],
    ["acme.example/{id}?q=1", "after {id}"],
    ["acme.example/{id}#top", "after {id}"],
    [`acme.example/${"x".repeat(200)}/{id}`, "longer than 200"],
  ])("refuses %j", (input, error) => {
    const parsed = parseUrlPattern(input);
    expect(parsed.ok ? "" : parsed.error).toContain(error);
  });

  it.each(["https://acme.example/browse/{id}", "https://acme.example/?issue={id}", "https://acme.example:8443/x/{id}/view", "HTTPS://acme.example/{id}"])(
    "accepts the task link %s",
    (input) => expect(checkUrlTemplate(input)).toBeUndefined(),
  );

  it.each([
    ["http://acme.example/{id}", "must start with https://"],
    ["https://acme.example/{id}/{id}", "exactly one {id}"],
    ["https://acme.example/x", "exactly one {id}"],
    ["https://{id}.acme.example/", "after the host"],
    ["https://acme.{id}/x", "after the host"],
    ["https://acme.example/{{id}}", "a brace"],
    ["https://acme.example/{id}{", "a brace"],
    ["https://acme.example/a b/{id}", "spaces or control"],
    ["https://acme.example/\u0007/{id}", "spaces or control"],
    ["https://user:pw@acme.example/{id}", "user name or password"],
    ["javascript:alert(1)//{id}", "must start with https://"],
    [`https://acme.example/${"x".repeat(300)}{id}`, "longer than 300"],
  ])("refuses the task link %j", (input, error) => {
    expect(checkUrlTemplate(input)).toContain(error);
  });
});

const NUMERIC: TaskRefInput = {
  id: pattern("[1-9]\\d{3,8}"),
  idInText: pattern("[1-9]\\d{4,8}"),
  prefixes: ["ticket", "ticket id"],
  keywords: ["ticket", "ticket id", "bug"],
  bare: false,
  urls: [url("tracker.example/ticket/{id}"), url("tracker.example/tickets/{id}")],
  caseInsensitive: false,
};

const KEYED: TaskRefInput = {
  id: pattern("ACME-[1-9]\\d{0,6}"),
  idInText: pattern("ACME-[1-9]\\d{0,6}"),
  prefixes: ["issue"],
  keywords: [],
  bare: true,
  urls: [url("acme.example/browse/{id}")],
  caseInsensitive: true,
};

describe("the regexes around an ID", () => {
  const numeric = buildTaskRefRegexes(NUMERIC);
  const keyed = buildTaskRefRegexes(KEYED);

  it("reads a whole input that is a task URL", () => {
    const exact = (s: string) => firstGroup(numeric.urlExact!.exec(s));
    expect(exact("https://tracker.example/ticket/41358")).toBe("41358");
    expect(exact("http://tracker.example/tickets/41358?tab=1#top")).toBe("41358");
    expect(exact("tracker.example/ticket/41358/")).toBe("41358");
    expect(exact("HTTPS://TRACKER.example/TICKET/41358")).toBe("41358");
    expect(exact("https://evil.example/tracker.example/ticket/41358")).toBeUndefined();
    expect(exact("https://tracker.example/ticket/999")).toBeUndefined();
    expect(exact("https://tracker.example/project/41358")).toBeUndefined();
    expect(exact("https://tracker.example/ticket/41358 and more")).toBeUndefined();
  });

  it("finds task URLs in text, the first by position winning", () => {
    expect(allMatches(numeric.urlInText!, "see tracker.example/tickets/99999 then https://tracker.example/ticket/41358")).toEqual(["99999", "41358"]);
    expect(allMatches(numeric.urlInText!, "https://tracker.example/ticket/41358 then tracker.example/tickets/99999")).toEqual(["41358", "99999"]);
    expect(allMatches(numeric.urlInText!, "xtracker.example/ticket/41358")).toEqual([]);
    // A link that ends in the ID ends at a word edge.
    expect(allMatches(numeric.urlInText!, "tracker.example/ticket/41358x tracker.example/ticket/41358.")).toEqual(["41358"]);
  });

  it("ends a link in text at the end of the pattern, whatever its last character is", () => {
    const find = (urlPattern: string, text: string) => {
      const re = buildTaskRefRegexes({ ...NUMERIC, urls: [url(urlPattern)] }).urlInText!;
      return allMatches(re, text);
    };
    // After a "/" no word edge is needed (a `\b` there wants a word character next).
    expect(find("tracker.example/t/{id}/", "see tracker.example/t/12345/ now")).toEqual(["12345"]);
    expect(find("tracker.example/t/{id}/", "see tracker.example/t/12345/")).toEqual(["12345"]);
    expect(find("tracker.example/t/{id}/", "see tracker.example/t/12345/details")).toEqual(["12345"]);
    expect(find("tracker.example/t/{id}/", "see tracker.example/t/12345 now")).toEqual([]);
    // After a word character the edge still counts.
    expect(find("tracker.example/t/{id}.html", "see tracker.example/t/12345.html now")).toEqual(["12345"]);
    expect(find("tracker.example/t/{id}.html", "see tracker.example/t/12345.htmlx")).toEqual([]);
    expect(find("tracker.example/t/{id}", "see tracker.example/t/12345/ now, tracker.example/t/67890x")).toEqual(["12345"]);
    // Several links with different endings, side by side.
    const mixed = buildTaskRefRegexes({ ...NUMERIC, urls: [url("tracker.example/a/{id}/"), url("tracker.example/b/{id}")] }).urlInText!;
    expect(allMatches(mixed, "tracker.example/b/11111x tracker.example/a/22222/ tracker.example/b/33333 end")).toEqual(["22222", "33333"]);
  });

  it("reads a whole input that is an ID, with # or a prefix, at most 3 spaces on each side of a separator", () => {
    const direct = (s: string) => numeric.directId.exec(s)?.[1];
    const ok = ["41358", "#41358", "ticket 41358", "Ticket: 41358", "ticket id #41358", "TICKET-41358", "ticket/41358", "ticket   #   41358", "ticket\t41358", `ticket${" ".repeat(6)}41358`];
    for (const s of ok) expect([s, direct(s)]).toEqual([s, "41358"]);
    const no = [`ticket${" ".repeat(7)}41358`, "ticket #    41358", "ticket    # 41358", "bug 41358", "ticket 999", "ticket 41358 x", " 41358"];
    for (const s of no) expect([s, direct(s)]).toEqual([s, undefined]);
    expect(buildTaskRefRegexes({ ...NUMERIC, prefixes: [] }).directId.exec("#41358")?.[1]).toBe("41358");
    expect(buildTaskRefRegexes({ ...NUMERIC, prefixes: [] }).directId.exec("ticket 41358")).toBeNull();
  });

  it("finds a keyword and an ID in text, at word edges, with bounded separators", () => {
    const find = (s: string) => allMatches(numeric.keywordInText!, s);
    expect(find("Fix (ticket 5290417)")).toEqual(["5290417"]);
    expect(find("bug #41358: crash")).toEqual(["41358"]);
    expect(find("ticket id: 41358")).toEqual(["41358"]);
    expect(find("ticket\t\t\t41358")).toEqual(["41358"]);
    expect(find("ticket   #   41358")).toEqual(["41358"]);
    expect(find("tíckét 41358 / ticket-41358")).toEqual(["41358"]);
    expect(find(`ticket${" ".repeat(7)}41358`)).toEqual(["41358"]);
    expect(find(`ticket${" ".repeat(8)}41358`)).toEqual([]);
    expect(find("ticket    # 41358")).toEqual([]);
    expect(find("xticket 41358")).toEqual([]);
    expect(find("ticket 41358x")).toEqual([]);
    expect(find("ticket 2026")).toEqual([]);
    expect(find("ticket 41358 and bug 52469")).toEqual(["41358", "52469"]);
  });

  it("finds bare IDs in text for self-describing keys, case-insensitively, then checks the case", () => {
    expect(allMatches(keyed.bare!, "Fixes ACME-12 and acme-13 (ACME-0)")).toEqual(["ACME-12", "acme-13"]);
    expect(allMatches(keyed.bare!, "xACME-12 ACME-12x ACME-12")).toEqual(["ACME-12"]);
    expect(keyed.id.test("acme-13")).toBe(true);
    expect(buildTaskRefRegexes({ ...KEYED, caseInsensitive: false }).id.test("acme-13")).toBe(false);
    expect(keyed.directId.exec("issue ACME-12")?.[1]).toBe("ACME-12");
    expect(firstGroup(keyed.urlExact!.exec("https://acme.example/browse/ACME-12"))).toBe("ACME-12");
  });

  it("reads a branch segment that starts with an ID", () => {
    const seg = (s: string) => numeric.branchSegment.exec(s)?.[1];
    expect(seg("41358-fix")).toBe("41358");
    expect(seg("41358_fix")).toBe("41358");
    expect(seg("41358")).toBe("41358");
    expect(seg("41358x")).toBeUndefined();
    expect(seg("fix-41358")).toBeUndefined();
    expect(keyed.branchSegment.exec("acme-12-login")?.[1]).toBe("acme-12");
  });

  it("builds only what the config has", () => {
    const bare = buildTaskRefRegexes({ ...NUMERIC, keywords: [], urls: [], bare: false });
    expect(bare.urlExact).toBeUndefined();
    expect(bare.urlInText).toBeUndefined();
    expect(bare.keywordInText).toBeUndefined();
    expect(bare.bare).toBeUndefined();
  });

  it("escapes keywords and prefixes as literals", () => {
    expect(escapeLiteral("a.b")).toBe("a\\.b");
    expect(escapeLiteral(" x   y ")).toBe("x\\s{1,3}y");
    expect(escapeLiteral("c++ (x) [y] {z} | $ ^ / \\")).toBe("c\\+\\+\\s{1,3}\\(x\\)\\s{1,3}\\[y\\]\\s{1,3}\\{z\\}\\s{1,3}\\|\\s{1,3}\\$\\s{1,3}\\^\\s{1,3}\\/\\s{1,3}\\\\");
    expect(() => new RegExp(escapeLiteral("c++ (x) [y] {z} | $ ^ / \\ - # :"), "u")).not.toThrow();
    const special = buildTaskRefRegexes({ ...NUMERIC, keywords: ["c++ task", "a.b"], prefixes: ["c++ task"] });
    expect(allMatches(special.keywordInText!, "c++  task 41358, aXb 52469, a.b 63571")).toEqual(["41358", "63571"]);
    expect(special.directId.exec("C++ TASK 41358")?.[1]).toBe("41358");
  });
});

describe("the adversarial probe", () => {
  /** Patterns at the grammar's limits: the longest IDs, the most ways to match, whitespace and punctuation IDs. */
  const PROBE_PATTERNS = [
    "[^\\s,]{1,64}",
    "[^,]{1,64}",
    "\\w{1,16}\\w{1,16}",
    "\\d?\\d?\\d?\\d?\\d?\\d?\\d?\\d?1",
    "[0-9a-z\\-]{0,31}[0-9a-z\\-]{1,8}",
    "\\s{1,64}",
    "\\-{1,64}",
    "\\#{1,64}",
    "[a-z\\-\\#]{1,16}[0-9]{1,16}",
    "ACME-[1-9]\\d{0,6}",
    "[1-9]\\d{3,8}",
  ];

  const configs: TaskRefInput[] = PROBE_PATTERNS.flatMap((p) => [
    { ...NUMERIC, id: pattern(p), idInText: pattern(p), bare: true, keywords: ["ticket", "ticket id", "a b c", "-", "#"], prefixes: ["ticket", "a b c", "#"] },
    { ...KEYED, id: pattern(p), idInText: pattern(p) },
  ]);

  /** A deterministic mix of the characters that make regexes backtrack. */
  function mix(seed: number, alphabet: string, length: number): string {
    let x = seed;
    let out = "";
    for (let i = 0; i < length; i++) {
      x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
      out += alphabet[x % alphabet.length];
    }
    return out;
  }

  const N = 10_000;
  const INPUTS: Array<[string, string]> = [
    ["digits", "1".repeat(N)],
    ["letters", "a".repeat(N)],
    ["dashes", "-".repeat(N)],
    ["hashes", "#".repeat(N)],
    ["spaces", " ".repeat(N)],
    ["whitespace", "\t \n ".repeat(N / 4)],
    ["digit-dash", "1-".repeat(N / 2)],
    ["letter-digit", "a1".repeat(N / 2)],
    ["hash-digit-space", "#1 ".repeat(N / 3)],
    ["keyword-space", "ticket ".repeat(N / 7)],
    ["keyword then spaces", `ticket${" ".repeat(N - 6)}`],
    ["keyword-hash", "ticket #".repeat(N / 8)],
    ["keyword-digit", "ticket 1".repeat(N / 8)],
    ["spaced keyword", "a b c ".repeat(N / 6)],
    ["spaced keyword, wide", "a   b   c   #   ".repeat(N / 16)],
    ["key prefix", "ACME-".repeat(N / 5)],
    ["key, lower", "acme-1".repeat(N / 6)],
    ["url start", "tracker.example/ticket/".repeat(N / 23)],
    ["scheme", "https://".repeat(N / 8)],
    ["almost an ID", `${"1".repeat(N - 1)}x`],
    ["mix 1", mix(1, "1a-# \t", N)],
    ["mix 2", mix(2, "1-#: /", N)],
    ["mix 3", mix(3, "ticket 1#-", N)],
  ];

  it("keeps every built regex fast on 10,000 hostile characters", () => {
    const slow: string[] = [];
    let worst = 0;
    for (const config of configs) {
      const built = buildTaskRefRegexes(config);
      const regexes = Object.entries(built).filter((e): e is [string, RegExp] => e[1] instanceof RegExp);
      for (const [name, re] of regexes) {
        for (const [inputName, input] of INPUTS) {
          const started = performance.now();
          if (re.global) allMatches(re, input);
          else re.exec(input);
          const took = performance.now() - started;
          worst = Math.max(worst, took);
          if (took > 250) slow.push(`${config.id.source} ${name} on ${inputName}: ${took.toFixed(0)} ms`);
        }
      }
    }
    expect(slow).toEqual([]);
    expect(worst).toBeLessThan(250);
  });

  it("scans at most 5,000 characters of a text, and never reads a reference the cut shortened", () => {
    expect(MAX_SCAN_TEXT).toBe(5_000);
    const numeric = buildTaskRefRegexes(NUMERIC);
    const refs = (text: string) => allMatches(numeric.keywordInText!, scanText(text, MAX_SCAN_TEXT));
    const filler = "x ".repeat(2_494); // 4,988 characters
    expect(filler.length).toBe(4_988);
    // The reference ends exactly at the cut, or the character after the cut is a space: it is whole.
    expect(refs(`${filler}ticket 52`)).toEqual([]);
    expect(refs(`${filler}ticket 52904`)).toEqual(["52904"]);
    expect(refs(`${filler}ticket 52904 and more`)).toEqual(["52904"]);
    // The cut falls inside the ID: 529041 is not read as 52904 (nor 5290 as anything).
    expect(refs(`${filler}ticket 529041`)).toEqual([]);
    expect(refs(`${filler}ticket 5290417 x`)).toEqual([]);
    expect(refs(`${filler}ticket:529041`)).toEqual([]);
    // The word the cut falls in goes whole, however long it is: a complete reference in it isn't read either.
    expect(refs(`ticket 529041-${"y".repeat(6_000)}`)).toEqual([]);
    expect(refs(`see ticket 529041 and ticket 63571-${"y".repeat(6_000)}`)).toEqual(["529041"]);
    // A reference after the cut is not read; one before it is.
    expect(refs(`ticket 52469 ${"x ".repeat(2_600)}ticket 41358`)).toEqual(["52469"]);
    // Not text with words in it: nothing to cut back to.
    expect(scanText("y".repeat(6_000), MAX_SCAN_TEXT)).toBe("");
    expect(scanText("short", MAX_SCAN_TEXT)).toBe("short");
  });

  it("cuts a branch name at a `/` or a space, so a segment is whole or gone", () => {
    const re = buildTaskRefRegexes(NUMERIC).branchSegment;
    const segments = (branch: string) => scanText(branch, MAX_BRANCH).split("/").map((s) => re.exec(s)?.[1]).filter(Boolean);
    expect(segments(`${"a/".repeat(148)}529041-x`)).toEqual([]); // 296 characters, then the ID across the cut
    expect(segments(`${"a/".repeat(147)}52904-x`)).toEqual([]); // the cut is after the "-", inside the segment
    expect(segments(`${"a/".repeat(147)}52904`)).toEqual(["52904"]); // 299 characters: not cut
    expect(segments(`${"a/".repeat(147)}52904/tail`)).toEqual(["52904"]); // cut inside "tail": back to the "/" after the ID
    expect(scanText(`${"a/".repeat(147)}529041-x`, MAX_BRANCH)).toBe(`${"a/".repeat(146)}a`); // the cut is after 529041
    // The segment the cut falls in goes whole, however long it is.
    expect(segments(`feature/529041-${"y".repeat(400)}`)).toEqual([]);
  });
});
