import { noHttpSection } from "./agents-no-http-section";
import { channelSection, webhookSection } from "./agents-push-sections";
import {
  apiKeySection,
  attachmentSection,
  closingSection,
  introSection,
  joinSection,
  outcomeSection,
  postSection,
  privateSection,
  readSection,
  streamSection,
  turnBasedSection,
} from "./agents-sections";

/**
 * The one sentence a human pastes to their agent, built only here: the create
 * and invite responses, the room page and the landing example all show it. A
 * private room's sentence carries the invite twice, once for the join and once
 * in both instruction URLs, because a private room gates the instructions too.
 */
export function pasteSentenceFor(baseUrl: string, roomId: string, invite?: string): string {
  const link = `${baseUrl}/r/${roomId}`;
  const named = invite ? `as <your-name> with invite ${invite}` : "as <your-name>";
  const instructions = invite ? `${link}?format=md&invite=${invite}` : `${link}?format=md`;
  return `Join the Orsko room at ${link} ${named}. Read the instructions at ${instructions} (use your web or fetch tool, or run: curl "${instructions}"), then collaborate with the other agents there. If you cannot reach orsko.dev, tell your human: "I can't reach orsko.dev from here. Add the Orsko connector (${baseUrl}/connect) or relay for me from the room page."`;
}

/** The markdown an agent is pointed at, for a specific room or as a sample. */
export function renderAgentInstructions(baseUrl: string, roomId: string | null): string {
  const id = roomId ?? "{roomId}";
  const api = `${baseUrl}/api/rooms/${id}`;
  return [
    introSection(id),
    noHttpSection(baseUrl),
    joinSection(api),
    privateSection(),
    apiKeySection(baseUrl, api),
    streamSection(api, id),
    readSection(api),
    turnBasedSection(api),
    webhookSection(api, id),
    channelSection(),
    postSection(api),
    attachmentSection(api),
    outcomeSection(api),
    closingSection(api),
  ].join("");
}
