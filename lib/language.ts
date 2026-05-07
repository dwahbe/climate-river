import { francAll } from "franc-min";

export type LanguageDetectionSource = "metadata" | "content";

export const LANGUAGE_SOURCE_METADATA: LanguageDetectionSource = "metadata";
export const LANGUAGE_SOURCE_CONTENT: LanguageDetectionSource = "content";

export type LanguageDetection = {
  languageCode: string | null;
  languageRawCode: string | null;
  languageConfidence: number | null;
  languageSource: LanguageDetectionSource;
  textLength: number;
  margin: number | null;
  isConfident: boolean;
  isConfidentNonEnglish: boolean;
};

export type ArticleLanguageGate =
  | {
      skip: true;
      language: LanguageDetection;
      reason: "non_english";
    }
  | {
      skip: false;
      language: LanguageDetection;
    };

const FRANC_MIN_LENGTH = 30;
const CONTENT_MIN_LENGTH = 200;

const THRESHOLDS: Record<
  LanguageDetectionSource,
  { minScore: number; minMargin: number }
> = {
  metadata: { minScore: 0.95, minMargin: 0.2 },
  content: { minScore: 0.85, minMargin: 0.05 },
};

const ISO_639_3_TO_1: Record<string, string> = {
  arb: "ar",
  ben: "bn",
  bul: "bg",
  ces: "cs",
  cmn: "zh",
  deu: "de",
  ell: "el",
  eng: "en",
  fra: "fr",
  hin: "hi",
  ind: "id",
  ita: "it",
  jpn: "ja",
  kor: "ko",
  nld: "nl",
  pes: "fa",
  pol: "pl",
  por: "pt",
  ron: "ro",
  rus: "ru",
  spa: "es",
  swe: "sv",
  tam: "ta",
  tel: "te",
  tur: "tr",
  ukr: "uk",
  urd: "ur",
  vie: "vi",
};

function normalizeText(...parts: Array<string | null | undefined>) {
  return parts
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function toLanguageCode(rawCode: string | null) {
  if (!rawCode || rawCode === "und") return null;
  return ISO_639_3_TO_1[rawCode] ?? rawCode;
}

export function shouldDetectLanguageFromContent(
  contentText: string | null | undefined,
) {
  return normalizeText(contentText).length >= CONTENT_MIN_LENGTH;
}

export function detectLanguage(
  text: string | null | undefined,
  source: LanguageDetectionSource,
): LanguageDetection {
  const normalized = normalizeText(text);
  const empty: LanguageDetection = {
    languageCode: null,
    languageRawCode: null,
    languageConfidence: null,
    languageSource: source,
    textLength: normalized.length,
    margin: null,
    isConfident: false,
    isConfidentNonEnglish: false,
  };

  if (!normalized) return empty;

  const guesses = francAll(normalized, { minLength: FRANC_MIN_LENGTH });
  const [topCode, topScore] = guesses[0] ?? ["und", 0];
  const [, runnerUpScore] = guesses[1] ?? [null, 0];
  const margin = topCode === "und" ? null : topScore - runnerUpScore;
  const threshold = THRESHOLDS[source];
  const isConfident =
    topCode !== "und" &&
    topScore >= threshold.minScore &&
    margin !== null &&
    margin >= threshold.minMargin;
  const languageCode = isConfident ? toLanguageCode(topCode) : null;

  return {
    languageCode,
    languageRawCode: topCode,
    languageConfidence: topCode === "und" ? null : topScore,
    languageSource: source,
    textLength: normalized.length,
    margin,
    isConfident,
    isConfidentNonEnglish: isConfident && languageCode !== "en",
  };
}

export function detectArticleLanguageFromMetadata(
  title: string | null | undefined,
  dek?: string | null,
) {
  return detectLanguage(normalizeText(title, dek), LANGUAGE_SOURCE_METADATA);
}

export function classifyArticleLanguageForIngest(
  title: string | null | undefined,
  dek?: string | null,
): ArticleLanguageGate {
  const language = detectArticleLanguageFromMetadata(title, dek);

  if (language.isConfidentNonEnglish) {
    return { skip: true, reason: "non_english", language };
  }

  return { skip: false, language };
}

export function detectArticleLanguageFromContent(
  contentText: string | null | undefined,
) {
  return detectLanguage(contentText, LANGUAGE_SOURCE_CONTENT);
}

export function detectBestArticleLanguage(input: {
  title?: string | null;
  dek?: string | null;
  contentText?: string | null;
}) {
  if (shouldDetectLanguageFromContent(input.contentText)) {
    return detectArticleLanguageFromContent(input.contentText);
  }

  return detectArticleLanguageFromMetadata(input.title, input.dek);
}

export function isEnglishOrUnknownLanguageCode(languageCode: string | null) {
  return languageCode === null || languageCode === "en";
}
