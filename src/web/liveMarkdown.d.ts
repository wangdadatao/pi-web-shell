export interface StableEnd {
  /** End offset (exclusive) of the last region that can be rendered on its own. */
  end: number;
  /** Whether a code fence is still open at the end of the text. */
  inFence: boolean;
}

/** Find the safe commit boundary in `text`, scanning from `from`. */
export function findStableEnd(text: string, from?: number): StableEnd;

/** Whether `next` continues the Markdown list that `prev` committed. */
export function continuesList(prev: string, next: string): boolean;
