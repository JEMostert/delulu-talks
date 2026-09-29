import { readPersonalProfiles } from "./personalProfiles";
import type { CustomWord } from "./types";

export type RuleProfileContext = { profileId?: string | null };
export function validRuleProfileId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && !!value.trim();
}
/** Omitted legacy scope is global; invalid or unavailable context never globalizes it. */
export function ruleAppliesToProfile(rule: CustomWord, context: RuleProfileContext = {}): boolean {
  return rule.profileId === undefined ||
    (validRuleProfileId(rule.profileId) && validRuleProfileId(context.profileId) && rule.profileId === context.profileId);
}
export function ruleProfileScopesOverlap(first: CustomWord, second: CustomWord): boolean {
  if (first.profileId !== undefined && !validRuleProfileId(first.profileId)) return false;
  if (second.profileId !== undefined && !validRuleProfileId(second.profileId)) return false;
  return first.profileId === undefined || second.profileId === undefined || first.profileId === second.profileId;
}
export function ruleProfileChoices(document: unknown): { id: string; name: string }[] {
  const result = readPersonalProfiles(document);
  return result.status === "supported" ? result.document.profiles.map(({ id, name }) => ({ id, name })) : [];
}
