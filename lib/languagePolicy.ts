export const ENGLISH_LANGUAGE_PROMPT_CONSTRAINT = "English-language";

export function visibleLanguagePredicate(alias?: string) {
  const prefix = alias ? `${alias}.` : "";
  return `(${prefix}language_code = 'en' OR ${prefix}language_code IS NULL)`;
}
