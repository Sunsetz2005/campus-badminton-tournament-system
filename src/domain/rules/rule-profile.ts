import { createHash } from "node:crypto";
import { z } from "zod";

export const ruleConfigSchema = z
  .object({
    bestOf: z.number().int().positive().refine((value) => value % 2 === 1, "局数必须为正奇数"),
    targetPoints: z.number().int().positive(),
    winBy: z.number().int().positive(),
    capPoints: z.number().int().positive(),
    intervalAt: z.number().int().positive(),
    intervalSeconds: z.number().int().nonnegative(),
    betweenGamesSeconds: z.number().int().nonnegative(),
    decidingGameChangeEndsAt: z.number().int().positive(),
  })
  .superRefine((value, context) => {
    if (value.capPoints < value.targetPoints) {
      context.addIssue({ code: "custom", path: ["capPoints"], message: "封顶分不能低于目标分" });
    }
    if (value.intervalAt >= value.targetPoints) {
      context.addIssue({ code: "custom", path: ["intervalAt"], message: "间歇阈值必须低于目标分" });
    }
    if (value.decidingGameChangeEndsAt >= value.targetPoints) {
      context.addIssue({
        code: "custom",
        path: ["decidingGameChangeEndsAt"],
        message: "决胜局换边阈值必须低于目标分",
      });
    }
  });

export type RuleConfig = z.infer<typeof ruleConfigSchema>;

export const traditional21Demo: RuleConfig = Object.freeze({
  bestOf: 3,
  targetPoints: 21,
  winBy: 2,
  capPoints: 30,
  intervalAt: 11,
  intervalSeconds: 60,
  betweenGamesSeconds: 120,
  decidingGameChangeEndsAt: 11,
});

export const alternative3x15Demo: RuleConfig = Object.freeze({
  bestOf: 3,
  targetPoints: 15,
  winBy: 2,
  capPoints: 21,
  intervalAt: 8,
  intervalSeconds: 60,
  betweenGamesSeconds: 120,
  decidingGameChangeEndsAt: 8,
});

export const singleGame21Demo: RuleConfig = Object.freeze({
  bestOf: 1,
  targetPoints: 21,
  winBy: 2,
  capPoints: 30,
  intervalAt: 11,
  intervalSeconds: 60,
  betweenGamesSeconds: 0,
  decidingGameChangeEndsAt: 11,
});

export function validateRuleConfig(input: unknown) {
  return ruleConfigSchema.parse(input);
}

export function hashRuleConfig(config: RuleConfig) {
  const validated = validateRuleConfig(config);
  return createHash("sha256").update(JSON.stringify(validated)).digest("hex");
}
