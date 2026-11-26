import type { ParsedPlan } from "./domain/types.ts";

export const redGaps = (input: {
  plan: ParsedPlan;
  task: string;
  changed: readonly string[];
  report?: string | undefined;
  redExits?: ReadonlyMap<string, number | null>;
}) => {
  const task = input.plan.tasks.find(
    (candidate) => candidate.id === input.task
  );

  const lines = (input.report ?? "").split(/\r?\n/u);
  const start = lines.indexOf("## Observed RED failures");

  const section =
    start === -1
      ? ""
      : (lines
          .slice(start + 1)
          .join("\n")
          .split(/^#{1,2} /mu)[0] ?? "");

  return input.plan.criteria
    .filter(
      (c) =>
        task?.criteria.includes(c.id) === true &&
        c.evidence === "red" &&
        c.red !== null &&
        c.red !== "" &&
        (c.redException === null || c.redException === "")
    )
    .filter((c) => {
      const status = input.redExits?.get(c.id);

      return !(Number.isInteger(status) && status !== 0);
    })
    .filter(
      (c) =>
        !new RegExp(`(?:^|[^A-Za-z0-9])${c.id}(?:$|[^A-Za-z0-9])`, "u").test(
          section
        ) && !c.tests.some((file) => section.includes(file))
    )
    .map((c) => ({
      criterion: c.id,
      line: c.line,
      testsTouched: c.tests.some((file) => input.changed.includes(file)),
    }));
};
