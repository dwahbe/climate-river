import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyArticleLanguageForIngest,
  detectArticleLanguageFromContent,
  detectArticleLanguageFromMetadata,
  detectBestArticleLanguage,
  isEnglishOrUnknownLanguageCode,
  shouldDetectLanguageFromContent,
} from "../language";

describe("language detection", () => {
  it("accepts confident English article text", () => {
    const result = detectArticleLanguageFromContent(
      "Climate scientists say rising global temperatures are intensifying heat waves, flooding, and drought risks across multiple regions. Governments are preparing new adaptation plans while researchers warn emissions cuts remain essential.",
    );

    assert.equal(result.languageCode, "en");
    assert.equal(result.isConfidentNonEnglish, false);
  });

  it("detects confident Spanish article text", () => {
    const result = detectArticleLanguageFromContent(
      "El cambio climatico esta aumentando la frecuencia de las olas de calor, las sequias y las inundaciones en muchas regiones. Los cientificos advierten que reducir las emisiones es urgente para proteger comunidades vulnerables.",
    );

    assert.equal(result.languageCode, "es");
    assert.equal(result.isConfidentNonEnglish, true);
  });

  it("treats very short headlines as unknown", () => {
    const result = detectArticleLanguageFromMetadata("Climate bill passes");

    assert.equal(result.languageCode, null);
    assert.equal(result.languageRawCode, "und");
    assert.equal(result.isConfidentNonEnglish, false);
  });

  it("keeps weak title-only guesses visible", () => {
    const result = detectArticleLanguageFromMetadata(
      "COP30 climate talks face pressure over fossil fuels",
    );

    assert.equal(result.languageCode, null);
    assert.equal(result.isConfidentNonEnglish, false);
  });

  it("uses the stricter metadata threshold to catch only clear non-English text", () => {
    const result = classifyArticleLanguageForIngest(
      "El cambio climatico aumenta las olas de calor en Espana y amenaza cultivos vulnerables",
      "Los cientificos advierten que las emisiones elevan el riesgo de sequias e inundaciones.",
    );

    assert.equal(result.skip, true);
    assert.equal(result.language.languageCode, "es");
  });

  it("does not reject English headlines with foreign place names", () => {
    const result = classifyArticleLanguageForIngest(
      "Brazil and Spain prepare new climate adaptation plans as Madrid heat waves intensify",
      "Officials in Sao Paulo and Barcelona said the policy would expand flood defenses and cooling centers.",
    );

    assert.equal(result.skip, false);
    assert.equal(result.language.isConfidentNonEnglish, false);
  });

  it("prefers full content over metadata when content is long enough", () => {
    const result = detectBestArticleLanguage({
      title: "Climate bill passes",
      dek: "A short English summary.",
      contentText:
        "El cambio climatico esta aumentando la frecuencia de las olas de calor, las sequias y las inundaciones en muchas regiones. Los cientificos advierten que reducir las emisiones es urgente para proteger comunidades vulnerables.",
    });

    assert.equal(result.languageSource, "content");
    assert.equal(result.languageCode, "es");
  });

  it("falls back to metadata when content is missing", () => {
    const result = detectBestArticleLanguage({
      title:
        "Spain braces for record heat as climate change drives temperatures higher",
      contentText: null,
    });

    assert.equal(result.languageSource, "metadata");
  });

  it("pins the content-length detection boundary", () => {
    assert.equal(shouldDetectLanguageFromContent("x".repeat(199)), false);
    assert.equal(shouldDetectLanguageFromContent("x".repeat(200)), true);
  });

  it("handles null and empty inputs as unknown", () => {
    assert.equal(detectArticleLanguageFromContent(null).languageCode, null);
    assert.equal(detectArticleLanguageFromMetadata("").languageCode, null);
  });

  it("treats only English and unknown codes as visible", () => {
    assert.equal(isEnglishOrUnknownLanguageCode("en"), true);
    assert.equal(isEnglishOrUnknownLanguageCode(null), true);
    assert.equal(isEnglishOrUnknownLanguageCode("es"), false);
  });
});
