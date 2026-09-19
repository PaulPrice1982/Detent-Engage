import { tokenise } from '@detent/awa-knowledge';
import { SUPPORT_ARTICLES, articleText, type SupportArticle } from './articles.js';

/**
 * The support assistant.
 *
 * It answers a customer's question about running Detent, from Detent's own
 * support articles and from nothing else. The discipline is the same one the
 * product sells: retrieve, ground, answer only from what was retrieved, and say
 * plainly when there is no answer rather than producing a plausible one.
 *
 * A support assistant that invents an answer is worse than no support assistant
 * at all, because the customer acts on it. So this one cannot: every answer it
 * gives is the text of an article, returned whole, with the article named. It
 * composes nothing. Where a language model is configured it may phrase the
 * hand-off around that text, but the text itself is never rewritten: that is
 * the line between summarising a source and becoming one.
 */

export interface SupportMatch {
  readonly article: SupportArticle;
  readonly score: number;
}

export interface SupportAnswer {
  /**
   * Whether the assistant found an answer it is willing to stand behind.
   *
   * 'answered'  : one article clearly matched.
   * 'ambiguous' , several matched and none led; the customer chooses.
   * 'unanswered', nothing matched well enough to show.
   */
  readonly outcome: 'answered' | 'ambiguous' | 'unanswered';
  /** The article to show, when one clearly led. */
  readonly article?: SupportArticle;
  /** Everything worth offering, best first. Empty when unanswered. */
  readonly matches: readonly SupportMatch[];
  /** What to say to the customer above the article. */
  readonly message: string;
  /** True when the customer should be offered a person. */
  readonly offerHuman: boolean;
}

/**
 * Below this, a match is noise.
 *
 * Retrieval always returns a best result, and the best result for a question
 * nobody wrote an article about is still an article. Without a floor the
 * assistant answers every question confidently and is wrong on the ones that
 * matter most: the unusual ones, which are exactly the ones a customer
 * bothers to ask.
 */
const MINIMUM_SCORE = 1.2;

/**
 * Words that carry no signal here, on top of the shared stop list.
 *
 * Nearly every article in this corpus is phrased as a question, so the words
 * that make a question a question are in almost all of them and distinguish
 * none. Left in, "what is the airspeed velocity of an unladen swallow" matches
 * an article about what happens when a visitor wants a person, on the strength
 * of "what", and the assistant offers it rather than admitting it has nothing.
 *
 * They are stripped here rather than in the shared tokeniser, because a
 * visitor asking a customer's assistant "what does it cost" is asking a real
 * question about a corpus where those words are not boilerplate.
 */
const QUESTION_WORDS = new Set([
  'what', 'how', 'when', 'where', 'why', 'who', 'which', 'whom', 'whose',
  'my', 'me', 'us', 'they', 'them', 'there', 'their',
  'have', 'has', 'had', 'will', 'would', 'should', 'shall', 'may', 'might',
  'need', 'want', 'get', 'got', 'if', 'not', 'no', 'any', 'about', 'into',
]);

/**
 * How much of the question has to be accounted for.
 *
 * A score alone does not say whether the question was understood or merely
 * brushed. One rare word in common between a six-word question and an article
 * can outscore a short article that answers it, so a match must also cover
 * enough of what was asked: a longer question has to land at least two of its
 * words, while a one- or two-word question ("logo", "credits") is allowed to
 * land on the single word it is.
 */
function coverageRequired(queryTokenCount: number): number {
  return queryTokenCount >= 3 ? 2 : 1;
}

/**
 * How far ahead the leader must be to be treated as the answer.
 *
 * Two articles scoring alike means the question was ambiguous, not that the
 * first is right. Showing one of them and hiding the other is a guess made on
 * the customer's behalf; showing both costs them one click and no trust.
 */
const LEAD_RATIO = 1.35;

export class SupportAgent {
  private readonly documents: { article: SupportArticle; tokens: string[] }[];
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(articles: readonly SupportArticle[] = SUPPORT_ARTICLES) {
    this.documents = articles.map((article) => ({
      article,
      tokens: tokenise(articleText(article)),
    }));
    for (const document of this.documents) {
      for (const token of new Set(document.tokens)) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
      }
    }
    const total = this.documents.reduce((sum, document) => sum + document.tokens.length, 0);
    this.averageLength = this.documents.length > 0 ? total / this.documents.length : 1;
  }

  /** Scores every article against the question, best first. */
  search(question: string, limit = 5): SupportMatch[] {
    const queryTokens = tokenise(question).filter((token) => !QUESTION_WORDS.has(token));
    if (queryTokens.length === 0) return [];
    const needed = coverageRequired(new Set(queryTokens).size);

    const k1 = 1.2;
    const b = 0.75;
    const count = this.documents.length;

    return this.documents
      .map(({ article, tokens }) => {
        const counts = new Map<string, number>();
        for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

        let score = 0;
        const covered = new Set<string>();
        for (const queryToken of queryTokens) {
          const frequency = counts.get(queryToken);
          if (!frequency) continue;
          covered.add(queryToken);
          const df = this.documentFrequency.get(queryToken) ?? 1;
          const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
          const denominator =
            frequency + k1 * (1 - b + (b * tokens.length) / (this.averageLength || 1));
          score += idf * ((frequency * (k1 + 1)) / denominator);
        }
        return {
          article,
          score: covered.size >= needed ? Math.round(score * 1000) / 1000 : 0,
        };
      })
      .filter((match) => match.score >= MINIMUM_SCORE)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  /** Answers a question, or declines to. */
  ask(question: string): SupportAnswer {
    const asked = question.trim();
    if (asked.length === 0) {
      return {
        outcome: 'unanswered',
        matches: [],
        message: 'Ask a question and I will find the answer.',
        offerHuman: false,
      };
    }

    const matches = this.search(asked);
    if (matches.length === 0) {
      return {
        outcome: 'unanswered',
        matches: [],
        message:
          'I have nothing written on that, so I am not going to guess at it. '
          + 'Raise a request below and a person will answer, include what you '
          + 'were doing and what happened.',
        offerHuman: true,
      };
    }

    const [best, second] = matches;
    const clear = !second || best!.score >= second.score * LEAD_RATIO;
    if (!clear) {
      return {
        outcome: 'ambiguous',
        matches,
        message: 'That could be a few things. Which of these did you mean?',
        offerHuman: true,
      };
    }

    return {
      outcome: 'answered',
      article: best!.article,
      matches,
      message: best!.article.kind === 'how-to' ? 'Here is how to do that.' : 'Here is the answer.',
      // Even a confident answer offers a person. An assistant that only offers
      // help when it has already failed leaves the customer who was answered
      // badly with nowhere to go.
      offerHuman: true,
    };
  }
}
