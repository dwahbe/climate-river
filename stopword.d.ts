declare module 'stopword' {
  export function removeStopwords<T extends string | string[]>(input: T): T;
  const sw: { removeStopwords: typeof removeStopwords };
  export default sw;
}
