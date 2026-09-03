import { describe, it, expect } from "vitest";
import { tokenizeQuery } from "../../src/text/tokenize";

// #326: the lexical arm for scripts that do not separate words with spaces, and
// for compatibility forms. ASCII input is covered by tokenize-query.test.ts and
// must stay byte-identical; everything here is the non-ASCII path.
describe("tokenizeQuery() beyond ASCII (#326)", () => {
  it("segments Japanese into words; particles fall to the length floor, auxiliaries to the stoplist", () => {
    expect(tokenizeQuery("認証方式を変更した理由")).toEqual(["認証", "方式", "変更", "理由"]);
  });

  it("never fabricates a term across a word boundary", () => {
    expect(tokenizeQuery("認証方式")).not.toContain("証方");
    expect(tokenizeQuery("東京都庁")).not.toContain("京都");
  });

  it("keeps the ASCII half of a mixed query and adds the CJK words", () => {
    expect(tokenizeQuery("Cloudflare 認証方式")).toEqual(["cloudflare", "認証", "方式"]);
    expect(tokenizeQuery("v1.9 の変更")).toEqual(["v1.9", "変更"]);
  });

  it("folds full-width Latin to its ASCII token and keeps the typed surface as a probe, after the tokens", () => {
    expect(tokenizeQuery("Ｃｌｏｕｄｆｌａｒｅ")).toEqual(["cloudflare", "Ｃｌｏｕｄｆｌａｒｅ"]);
    expect(tokenizeQuery("Ｖ１．９")).toEqual(["v1.9", "Ｖ１．９"]);
    expect(tokenizeQuery("５０％ｏｆｆ ＿ｆｏｏ")).toEqual(["50off", "foo", "５０％ｏｆｆ", "＿ｆｏｏ"]);
  });

  it("folds half-width katakana and keeps the typed surface as a probe", () => {
    expect(tokenizeQuery("ｷｬﾘｱ")).toEqual(["キャリア", "ｷｬﾘｱ"]);
  });

  it("emits a lone ideograph only when nothing else is available", () => {
    expect(tokenizeQuery("夢")).toEqual(["夢"]);
    expect(tokenizeQuery("2025年3月の認証方式")).toEqual(["2025", "認証", "方式"]);
  });

  it("drops Japanese and Chinese function words", () => {
    expect(tokenizeQuery("これは認証方式についてのメモです")).toEqual(["認証", "方式", "メモ"]);
    expect(tokenizeQuery("为什么没有认证")).toEqual(["认证"]);
  });

  it("keeps accented Latin words whole", () => {
    expect(tokenizeQuery("café naïve")).toEqual(["café", "naïve"]);
  });

  it("keeps an astral ideograph intact", () => {
    expect(tokenizeQuery("𠮷野家")).toEqual(["𠮷", "野家"]);
  });

  it("dedupes and preserves source order", () => {
    expect(tokenizeQuery("認証 認証 方式")).toEqual(["認証", "方式"]);
  });

  it("returns nothing for a query that is only particles", () => {
    expect(tokenizeQuery("は を の")).toEqual([]);
  });
});
