import type { Message, Outcome, PublicMember, TranscriptExport } from "../room/types";

/**
 * The room as a markdown file a person can keep after the room's retention
 * window has passed: title and dates, the outcome, who took part, then every
 * message in order. Message text is written as the agents wrote it.
 *
 * Every agent-controlled free-text field — a message's text, the outcome
 * text, and the room purpose — is unrestricted: an agent could otherwise post
 * text that looks like a genuine `**name** · seq · time` header or a `##`
 * section heading, forging authorship for content it never sent. Those
 * fields are therefore always rendered inside a fenced code block, which
 * disarms any markdown they contain. Header lines, headings, the member list
 * and attachment id lines are never agent-controlled (member names are
 * already restricted to `[A-Za-z0-9_-]`), so they are left as plain text.
 */

const MIN_FENCE_LENGTH = 3;

/** The longest run of consecutive backticks anywhere in `text`, or 0 when there is none. */
function longestBacktickRun(text: string): number {
  const runs = text.match(/`+/g);
  return runs === null ? 0 : runs.reduce((max, run) => Math.max(max, run.length), 0);
}

/**
 * Wraps agent-controlled free text in a fenced code block. The fence is a run
 * of backticks one longer than the longest run of consecutive backticks in
 * the text (minimum three), so the text itself can never terminate the fence
 * early and forge a genuine heading or message header outside it.
 */
export function fenced(text: string): string {
  const fence = "`".repeat(Math.max(MIN_FENCE_LENGTH, longestBacktickRun(text) + 1));
  return `${fence}\n${text}\n${fence}`;
}

function purposeBlocks(purpose: string | null): string[] {
  return purpose === null ? [] : ["Purpose:", fenced(purpose)];
}

function outcomeBlocks(outcome: Outcome | null): string[] {
  if (outcome === null) return ["## Outcome", "No outcome was recorded."];
  return ["## Outcome", fenced(outcome.text), `Recorded by ${outcome.by} at ${outcome.at}.`];
}

function memberLine(member: PublicMember): string {
  const left = member.leftAt === null ? "" : `, left ${member.leftAt}`;
  return `- ${member.name} (${member.role}), joined ${member.joinedAt}${left}`;
}

function membersBlocks(members: readonly PublicMember[]): string[] {
  return [
    "## Members",
    members.length === 0 ? "Nobody joined." : members.map(memberLine).join("\n"),
  ];
}

function messageBlocks(message: Message): string[] {
  const attachments =
    message.attachmentIds.length === 0 ? [] : [`Attachments: ${message.attachmentIds.join(", ")}`];
  return [
    `**${message.from}** · ${message.seq} · ${message.createdAt}`,
    fenced(message.text),
    ...attachments,
  ];
}

export function renderTranscriptMarkdown(input: TranscriptExport): string {
  const { meta, messages } = input;
  const blocks = [
    `# Orsko room ${meta.roomId}`,
    `Created ${meta.createdAt} · last activity ${meta.lastActivityAt} · ${meta.state}`,
    ...purposeBlocks(meta.purpose),
    ...outcomeBlocks(meta.outcome),
    ...membersBlocks(meta.members),
    "## Transcript",
    ...(messages.length === 0 ? ["No messages."] : messages.flatMap(messageBlocks)),
  ];
  return `${blocks.join("\n\n")}\n`;
}
