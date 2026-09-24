import type {
  MatchLifecycle,
  OutcomeType,
  PreviewScenario,
  PublicMatchPreview,
  VerificationState,
} from "./model";

const lifecycleValues = new Set<MatchLifecycle>(["SCHEDULED", "READY", "IN_PROGRESS", "SUSPENDED", "ENDED_PENDING_SUBMISSION", "SUBMITTED"]);
const verificationValues = new Set<VerificationState>(["UNVERIFIED", "PENDING_REVIEW", "DISPUTED", "SUPERSEDED", "LOCKED"]);
const outcomeValues = new Set<OutcomeType>(["NORMAL", "WO", "RET", "DSQ", "ABANDONED", "BYE"]);
const scenarioValues = new Set<PreviewScenario>(["ready", "loading", "empty", "error", "stale"]);

export interface ScheduleQueryIssue {
  key: string;
  rawValue: string;
  reason: "INVALID_DATE" | "UNKNOWN_OPTION" | "TOO_LONG";
}

export interface ScheduleQuery {
  competition: string | null;
  court: string | null;
  date: string;
  lifecycle: readonly MatchLifecycle[];
  outcome: readonly OutcomeType[];
  q: string;
  scenario: PreviewScenario;
  stage: string | null;
  verification: readonly VerificationState[];
}

export interface ParsedScheduleQuery {
  issues: readonly ScheduleQueryIssue[];
  value: ScheduleQuery;
}

export interface ScheduleQueryOptions {
  competitions: readonly string[];
  courts: readonly string[];
  dates: readonly string[];
  stages: readonly string[];
}

function parseEnumList<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: ReadonlySet<T>,
  issues: ScheduleQueryIssue[],
) {
  const raw = params.get(key);
  if (!raw) return [] as T[];
  const values = [...new Set(raw.split(",").filter(Boolean))];
  const valid: T[] = [];
  values.forEach((value) => {
    if (allowed.has(value as T)) valid.push(value as T);
    else issues.push({ key, rawValue: value, reason: "UNKNOWN_OPTION" });
  });
  return valid.sort();
}

export function parseScheduleQuery(
  params: URLSearchParams,
  options: ScheduleQueryOptions,
  fallbackDate: string,
): ParsedScheduleQuery {
  const issues: ScheduleQueryIssue[] = [];
  const rawDate = params.get("date");
  const date = rawDate || fallbackDate;
  if (rawDate && !options.dates.includes(rawDate)) issues.push({ key: "date", rawValue: rawDate, reason: "INVALID_DATE" });

  const rawQuery = params.get("q")?.normalize("NFKC").trim() ?? "";
  const q = rawQuery.slice(0, 60);
  if (rawQuery.length > 60) issues.push({ key: "q", rawValue: rawQuery, reason: "TOO_LONG" });

  const scenarioRaw = params.get("scenario");
  const scenario = scenarioRaw && scenarioValues.has(scenarioRaw as PreviewScenario)
    ? scenarioRaw as PreviewScenario
    : "ready";
  if (scenarioRaw && scenarioRaw !== scenario) {
    issues.push({ key: "scenario", rawValue: scenarioRaw, reason: "UNKNOWN_OPTION" });
  }

  const readOption = (key: "competition" | "court" | "stage", allowed: readonly string[]) => {
    const rawValue = params.get(key);
    if (!rawValue) return null;
    if (allowed.includes(rawValue)) return rawValue;
    issues.push({ key, rawValue, reason: "UNKNOWN_OPTION" });
    return null;
  };

  return {
    issues,
    value: {
      competition: readOption("competition", options.competitions),
      court: readOption("court", options.courts),
      date,
      lifecycle: parseEnumList(params, "lifecycle", lifecycleValues, issues),
      outcome: parseEnumList(params, "outcome", outcomeValues, issues),
      q,
      scenario,
      stage: readOption("stage", options.stages),
      verification: parseEnumList(params, "verification", verificationValues, issues),
    },
  };
}

export function filterPreviewMatches(matches: readonly PublicMatchPreview[], query: ScheduleQuery) {
  const normalizedSearch = query.q.toLocaleLowerCase("zh-CN");
  return matches.filter((match) => {
    if (match.scheduleDate !== query.date) return false;
    if (query.competition && match.competitionCode !== query.competition) return false;
    if (query.court && match.court !== query.court) return false;
    if (query.stage && match.stageCode !== query.stage) return false;
    if (query.lifecycle.length && !query.lifecycle.includes(match.lifecycle)) return false;
    if (query.verification.length && !query.verification.includes(match.verification)) return false;
    if (query.outcome.length && !query.outcome.includes(match.outcome)) return false;
    if (!normalizedSearch) return true;

    const publicSearchFields = [
      match.code,
      match.competitionName,
      match.stageName,
      match.court ?? "",
      match.sideA?.code ?? "",
      match.sideA?.displayName ?? "",
      match.sideA?.teamName ?? "",
      ...(match.sideA?.members.map((member) => `${member.publicCode} ${member.displayName}`) ?? []),
      match.sideB?.code ?? "",
      match.sideB?.displayName ?? "",
      match.sideB?.teamName ?? "",
      ...(match.sideB?.members.map((member) => `${member.publicCode} ${member.displayName}`) ?? []),
    ].join(" ").normalize("NFKC").toLocaleLowerCase("zh-CN");
    return publicSearchFields.includes(normalizedSearch);
  }).sort((first, second) => first.scheduleOrder - second.scheduleOrder);
}

export const preservedScheduleKeys = [
  "date",
  "competition",
  "stage",
  "court",
  "lifecycle",
  "verification",
  "outcome",
  "q",
  "scenario",
] as const;

export function preserveScheduleParams(input: URLSearchParams, options: ScheduleQueryOptions) {
  const output = new URLSearchParams();
  preservedScheduleKeys.forEach((key) => {
    const rawValue = input.get(key);
    if (!rawValue) return;

    if (key === "lifecycle" || key === "verification" || key === "outcome") {
      const allowed = key === "lifecycle" ? lifecycleValues : key === "verification" ? verificationValues : outcomeValues;
      const values = [...new Set(rawValue.split(",").filter((value) => allowed.has(value as never)))].sort();
      if (values.length) output.set(key, values.join(","));
      return;
    }

    if (key === "scenario") {
      if (scenarioValues.has(rawValue as PreviewScenario) && rawValue !== "ready") output.set(key, rawValue);
      return;
    }

    if (key === "q") {
      const value = rawValue.normalize("NFKC").trim().slice(0, 60);
      if (value) output.set(key, value);
      return;
    }

    if (key === "competition" || key === "court" || key === "stage") {
      const allowed = key === "competition" ? options.competitions : key === "court" ? options.courts : options.stages;
      if (allowed.includes(rawValue)) output.set(key, rawValue);
      return;
    }

    output.set(key, rawValue);
  });
  return output;
}

export function withScheduleQuery(
  pathname: string,
  current: URLSearchParams,
  updates: Record<string, string | null>,
  options: ScheduleQueryOptions,
) {
  const next = preserveScheduleParams(current, options);
  Object.entries(updates).forEach(([key, value]) => {
    if (value) next.set(key, value);
    else next.delete(key);
  });
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}
