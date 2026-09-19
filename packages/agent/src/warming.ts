/**
 * Educating the visitor, and mentioning what else exists, without selling.
 *
 * The assistant's job is not to book a meeting. It is to hand a person to a
 * salesperson already understanding what they are looking at, because the
 * meeting that follows a conversation where the buyer learned something is a
 * different meeting entirely from one booked off a form.
 *
 * Everything here exists to keep that from turning into a pitch. Three rules
 * do most of the work:
 *
 * 1. Teach before asking. A visitor who has been given something answers
 *    questions; a visitor who has been asked three questions leaves.
 * 2. A suggestion has to answer a question the visitor actually has. Mentioning
 *    something adjacent because it is worth more is the exact move that makes a
 *    conversation feel like a sales call.
 * 3. At most one suggestion in a conversation. The first reads as helpful. The
 *    second reads as a pitch, and the visitor stops believing the first.
 */

export interface KnowledgePoint {
  /** The approved answer this point comes from. Nothing here is composed. */
  readonly chunkId: string;
  readonly title: string;
  /** What the visitor learns. Must already be approved knowledge. */
  readonly text: string;
  /** Topics this speaks to, matched against what the visitor said. */
  readonly topics: readonly string[];
  /**
   * True when this describes something the customer would pay more for.
   *
   * Marked so it can be governed, not so it can be pushed: a point marked
   * commercial is held to the stricter test below.
   */
  readonly commercial?: boolean;
}

export interface WarmingState {
  /** Points already given, so nothing is said twice. */
  readonly taught: readonly string[];
  /** True once a commercial suggestion has been made. One is the limit. */
  readonly suggested: boolean;
  /** True once the visitor has been given something of substance. */
  readonly valueDelivered: boolean;
}

export const NEW_WARMING_STATE: WarmingState = {
  taught: [], suggested: false, valueDelivered: false,
};

export type WarmingMove =
  /** Say something useful the visitor did not know. */
  | { readonly kind: 'teach'; readonly point: KnowledgePoint; readonly reason: string }
  /** Mention an adjacent capability, once, as information. */
  | { readonly kind: 'suggest'; readonly point: KnowledgePoint; readonly reason: string }
  /** Say nothing extra. Answer what was asked and stop. */
  | { readonly kind: 'hold'; readonly reason: string };

export interface WarmingInput {
  /** What the visitor has said, for topic matching. Their words, not ours. */
  readonly saidSoFar: string;
  readonly available: readonly KnowledgePoint[];
  readonly state: WarmingState;
  /** True when the visitor's last turn was a direct question. */
  readonly visitorAskedQuestion: boolean;
  readonly visitorAskedForHuman: boolean;
  /** True once a meeting is booked: stop selling, they have said yes. */
  readonly meetingBooked: boolean;
}

/**
 * Chooses the next move.
 *
 * The order of the guards is the policy. Anything that stops the assistant
 * talking comes first, because the failure that costs a customer is not
 * missing a chance to educate: it is carrying on when the visitor wanted
 * something else.
 */
export function nextWarmingMove(input: WarmingInput): WarmingMove {
  if (input.visitorAskedForHuman) {
    return { kind: 'hold', reason: 'visitor asked for a person; hand over rather than continue' };
  }
  if (input.meetingBooked) {
    return {
      kind: 'hold',
      reason: 'meeting booked; nothing said now can improve it and a pitch can spoil it',
    };
  }

  const topics = topicsIn(input.saidSoFar);
  const untaught = input.available.filter((point) => !input.state.taught.includes(point.chunkId));

  // Relevance is required, not preferred. A point that matches nothing the
  // visitor said is a brochure paragraph, and reading one out is what makes an
  // assistant feel like an advert.
  const relevant = untaught
    .map((point) => ({ point, overlap: overlapWith(point, topics) }))
    .filter((scored) => scored.overlap > 0)
    .sort((left, right) => right.overlap - left.overlap);

  const plain = relevant.filter((scored) => !scored.point.commercial);
  const commercial = relevant.filter((scored) => scored.point.commercial);

  // Teaching something they asked about beats everything.
  if (input.visitorAskedQuestion && plain[0]) {
    return {
      kind: 'teach',
      point: plain[0].point,
      reason: 'answers what the visitor just asked, from approved knowledge',
    };
  }

  if (plain[0]) {
    return {
      kind: 'teach',
      point: plain[0].point,
      reason: 'relevant to what the visitor said and not yet told to them',
    };
  }

  // A commercial suggestion is allowed only after the visitor has had
  // something for nothing, only once, and only where it speaks to what they
  // themselves raised. Fail any of the three and say nothing.
  if (commercial[0]) {
    if (!input.state.valueDelivered) {
      return {
        kind: 'hold',
        reason: 'nothing given yet; a suggestion before that is a pitch',
      };
    }
    if (input.state.suggested) {
      return {
        kind: 'hold',
        reason: 'one suggestion already made; a second is what makes it feel like selling',
      };
    }
    return {
      kind: 'suggest',
      point: commercial[0].point,
      reason: 'speaks to something the visitor raised, offered once, as information',
    };
  }

  return { kind: 'hold', reason: 'nothing relevant left to say' };
}

/** Records a move, so the next turn knows what has been said. */
export function applyWarmingMove(state: WarmingState, move: WarmingMove): WarmingState {
  if (move.kind === 'hold') return state;
  return {
    taught: [...state.taught, move.point.chunkId],
    suggested: state.suggested || move.kind === 'suggest',
    // Teaching something is the value. A suggestion is not.
    valueDelivered: state.valueDelivered || move.kind === 'teach',
  };
}

const NOISE = new Set([
  'the', 'a', 'an', 'and', 'or', 'is', 'are', 'was', 'to', 'of', 'in', 'on',
  'for', 'with', 'at', 'by', 'from', 'as', 'it', 'this', 'that', 'we', 'our',
  'you', 'your', 'i', 'do', 'does', 'can', 'have', 'has', 'be', 'my', 'me',
  'what', 'how', 'when', 'where', 'why', 'about', 'any', 'need', 'want',
]);

function topicsIn(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((word) => word.length > 2 && !NOISE.has(word)),
  );
}

function overlapWith(point: KnowledgePoint, topics: Set<string>): number {
  let overlap = 0;
  for (const topic of point.topics) {
    const words = topic.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
    // A multi-word topic counts once, and only when every word of it is
    // present: "contract renewal" should not match on "contract" alone.
    if (words.length > 0 && words.every((word) => topics.has(word))) overlap += words.length;
  }
  return overlap;
}
