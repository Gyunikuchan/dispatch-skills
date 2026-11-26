export const CRITERION_ID_SOURCE = "SC[1-9][0-9]*";
const ID = new RegExp(`^${CRITERION_ID_SOURCE}$`, "u");

export const isCriterionId = (value: unknown): value is string =>
  typeof value === "string" && ID.exec(value)?.[0] === value;

export const criterionHeading = (text: string) => {
  const match = /^\[(?<cap1>[^\]]+)\]\s+/u.exec(text);

  return match && isCriterionId(match[1])
    ? { id: match[1], title: text.slice(match[0].length).trim() }
    : null;
};
