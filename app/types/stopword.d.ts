declare module "stopword" {
  export const eng: string[];
  export function removeStopwords(
    tokens: string[],
    stopwords?: string[],
  ): string[];
}
