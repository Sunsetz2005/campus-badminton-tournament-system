"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";
import {
  COMPETITION_CODE_PATTERN,
  COMPETITION_KIND_ENTRY_TYPE,
  COMPETITION_KIND_LABEL,
  type RegistrationCompetitionKind,
} from "@/domain/registration/registration-rules";

const STEPS = ["基本信息", "比赛项目", "规则与报名", "确认创建"] as const;

const RULE_OPTIONS = [
  { value: "traditional-21", label: "传统 21 分 · 三局两胜", detail: "21 分、赢 2 分、30 分封顶，11 分间歇" },
  { value: "alternative-3x15", label: "替代 3×15 · 三局两胜", detail: "15 分、赢 2 分、21 分封顶，8 分间歇" },
  { value: "single-game-21", label: "单局 21 分", detail: "一局定胜负，21 分、30 分封顶" },
] as const;

const KINDS = Object.keys(COMPETITION_KIND_LABEL) as RegistrationCompetitionKind[];

interface CompetitionDraft {
  key: number;
  kind: RegistrationCompetitionKind;
  code: string;
  name: string;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export function CreateTournamentWizard({ defaultTimezone }: { defaultTimezone: string }) {
  const router = useRouter();
  const formId = useId();
  const [step, setStep] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [basics, setBasics] = useState({
    name: "",
    slug: "",
    subtitle: "",
    organizer: "",
    venue: "",
    startDate: "",
    endDate: "",
    timezone: defaultTimezone,
    summary: "",
  });
  const [competitions, setCompetitions] = useState<CompetitionDraft[]>([
    { key: 1, kind: "MS", code: "MS", name: COMPETITION_KIND_LABEL.MS },
    { key: 2, kind: "WS", code: "WS", name: COMPETITION_KIND_LABEL.WS },
  ]);
  const [nextKey, setNextKey] = useState(3);
  const [rules, setRules] = useState({
    rulePreset: "traditional-21",
    namePolicy: "CODES_ONLY",
    registrationOpensAt: "",
    registrationClosesAt: "",
    regulations: "",
  });

  function stepErrors(index: number): string[] {
    const problems: string[] = [];
    if (index === 0) {
      if ([...basics.name.trim()].length < 2) problems.push("请填写赛事名称（至少 2 个字）。");
      if (!SLUG_PATTERN.test(basics.slug)) problems.push("访问路径只能用小写字母、数字和连字符，3—50 位，不能以连字符开头或结尾。");
      if (!basics.startDate || !basics.endDate) problems.push("请填写赛事开始和结束日期。");
      else if (basics.startDate > basics.endDate) problems.push("结束日期不能早于开始日期。");
      if (!basics.timezone.trim()) problems.push("请填写赛事时区。");
    }
    if (index === 1) {
      if (!competitions.length) problems.push("至少需要一个比赛项目。");
      const codes = competitions.map((item) => item.code.trim().toUpperCase());
      if (new Set(codes).size !== codes.length) problems.push("项目代码不能重复。");
      if (codes.some((code) => !COMPETITION_CODE_PATTERN.test(code))) problems.push("项目代码须以大写字母开头，只含字母、数字和连字符，最多 16 位。");
      if (competitions.some((item) => [...item.name.trim()].length < 2)) problems.push("每个项目都需要至少 2 个字的名称。");
    }
    if (index === 2) {
      if (rules.registrationOpensAt && rules.registrationClosesAt && rules.registrationOpensAt >= rules.registrationClosesAt) {
        problems.push("报名截止时间必须晚于开始时间。");
      }
    }
    return problems;
  }

  function goTo(target: number) {
    for (let index = 0; index < target; index += 1) {
      const problems = stepErrors(index);
      if (problems.length) {
        setStep(index);
        setError(problems.join(" "));
        return;
      }
    }
    setError(null);
    setStep(target);
  }

  function addCompetition(kind: RegistrationCompetitionKind) {
    const taken = new Set(competitions.map((item) => item.code));
    let code: string = kind;
    for (let suffix = 2; taken.has(code); suffix += 1) code = `${kind}-${suffix}`;
    setCompetitions([...competitions, { key: nextKey, kind, code, name: COMPETITION_KIND_LABEL[kind] }]);
    setNextKey(nextKey + 1);
  }

  function updateCompetition(key: number, patch: Partial<CompetitionDraft>) {
    setCompetitions(competitions.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step < STEPS.length - 1) {
      goTo(step + 1);
      return;
    }
    for (let index = 0; index < STEPS.length - 1; index += 1) {
      const problems = stepErrors(index);
      if (problems.length) {
        setStep(index);
        setError(problems.join(" "));
        return;
      }
    }
    setPending(true);
    setError(null);
    const result = await sendJson<{ slug: string }>("/api/admin/tournaments", "POST", {
      ...basics,
      ...rules,
      competitions: competitions.map(({ kind, code, name }) => ({ kind, code: code.trim().toUpperCase(), name })),
    });
    if (!result.ok) {
      setPending(false);
      setError(result.error.message);
      return;
    }
    router.push(`/management/${result.data.slug}`);
    router.refresh();
  }

  const ruleLabel = RULE_OPTIONS.find((option) => option.value === rules.rulePreset)?.label;

  return (
    <form className={styles.form} id={formId} noValidate onSubmit={submit}>
      <ol aria-label="创建步骤" className={styles.steps}>
        {STEPS.map((label, index) => (
          <li aria-current={index === step ? "step" : undefined} data-done={index < step} key={label}>
            {label}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <section className={styles.section} aria-labelledby={`${formId}-basics`}>
          <div className={styles.sectionTitle}>
            <h2 id={`${formId}-basics`}>基本信息</h2>
            <p>赛事创建后是草稿，不会出现在公开首页，直到你手动发布。</p>
          </div>
          <div className={styles.fieldGrid}>
            <label className={`${styles.field} ${styles.full}`}>
              <span>赛事名称 <em className={styles.required}>*</em></span>
              <input maxLength={60} onChange={(event) => setBasics({ ...basics, name: event.target.value })} required value={basics.name} />
            </label>
            <label className={styles.field}>
              <span>访问路径 <em className={styles.required}>*</em></span>
              <input
                autoCapitalize="none"
                inputMode="url"
                maxLength={50}
                onChange={(event) => setBasics({ ...basics, slug: event.target.value.toLowerCase() })}
                placeholder="autumn-cup-2026"
                required
                value={basics.slug}
              />
              <small>出现在公开网址中，创建后不能修改。</small>
            </label>
            <label className={styles.field}>
              <span>副标题</span>
              <input maxLength={80} onChange={(event) => setBasics({ ...basics, subtitle: event.target.value })} value={basics.subtitle} />
            </label>
            <label className={styles.field}>
              <span>主办单位</span>
              <input maxLength={60} onChange={(event) => setBasics({ ...basics, organizer: event.target.value })} value={basics.organizer} />
            </label>
            <label className={styles.field}>
              <span>比赛场馆</span>
              <input maxLength={60} onChange={(event) => setBasics({ ...basics, venue: event.target.value })} value={basics.venue} />
            </label>
            <label className={styles.field}>
              <span>开始日期 <em className={styles.required}>*</em></span>
              <input onChange={(event) => setBasics({ ...basics, startDate: event.target.value })} required type="date" value={basics.startDate} />
            </label>
            <label className={styles.field}>
              <span>结束日期 <em className={styles.required}>*</em></span>
              <input onChange={(event) => setBasics({ ...basics, endDate: event.target.value })} required type="date" value={basics.endDate} />
            </label>
            <label className={styles.field}>
              <span>赛事时区 <em className={styles.required}>*</em></span>
              <input onChange={(event) => setBasics({ ...basics, timezone: event.target.value })} required value={basics.timezone} />
              <small>报名截止等时间都按此时区解释，例如 Asia/Shanghai。</small>
            </label>
            <label className={`${styles.field} ${styles.full}`}>
              <span>赛事简介</span>
              <textarea maxLength={500} onChange={(event) => setBasics({ ...basics, summary: event.target.value })} value={basics.summary} />
            </label>
          </div>
        </section>
      ) : null}

      {step === 1 ? (
        <section className={styles.section} aria-labelledby={`${formId}-competitions`}>
          <div className={styles.sectionTitle}>
            <h2 id={`${formId}-competitions`}>比赛项目</h2>
            <p>单打每个报名 1 人，双打每个报名 2 人。同一单项可建多个组别，例如 MS-A 男单甲组。</p>
          </div>
          <ul className={styles.list}>
            {competitions.map((competition, index) => (
              <li className={styles.competitionRow} key={competition.key}>
                <label className={styles.field}>
                  <span>单项</span>
                  <select
                    onChange={(event) => updateCompetition(competition.key, { kind: event.target.value as RegistrationCompetitionKind })}
                    value={competition.kind}
                  >
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {COMPETITION_KIND_LABEL[kind]}（{COMPETITION_KIND_ENTRY_TYPE[kind] === "SINGLES" ? "单打" : "双打"}）
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span>项目代码</span>
                  <input
                    autoCapitalize="characters"
                    maxLength={16}
                    onChange={(event) => updateCompetition(competition.key, { code: event.target.value.toUpperCase() })}
                    value={competition.code}
                  />
                </label>
                <label className={styles.field}>
                  <span>项目名称</span>
                  <input maxLength={30} onChange={(event) => updateCompetition(competition.key, { name: event.target.value })} value={competition.name} />
                </label>
                <ActionButton
                  aria-label={`删除第 ${index + 1} 个项目`}
                  onClick={() => setCompetitions(competitions.filter((item) => item.key !== competition.key))}
                  size="sm"
                  variant="ghost"
                >
                  删除
                </ActionButton>
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            {KINDS.map((kind) => (
              <ActionButton key={kind} onClick={() => addCompetition(kind)} size="sm" variant="secondary">
                ＋ {COMPETITION_KIND_LABEL[kind]}
              </ActionButton>
            ))}
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section className={styles.section} aria-labelledby={`${formId}-rules`}>
          <div className={styles.sectionTitle}>
            <h2 id={`${formId}-rules`}>规则与报名</h2>
            <p>内置规则都是演示配置，正式比赛前须由组织者核对并采纳。</p>
          </div>
          <fieldset className={styles.fieldset}>
            <legend>计分规则</legend>
            {RULE_OPTIONS.map((option) => (
              <label className={styles.checkRow} key={option.value}>
                <input
                  checked={rules.rulePreset === option.value}
                  name="rulePreset"
                  onChange={() => setRules({ ...rules, rulePreset: option.value })}
                  type="radio"
                />
                <span><strong>{option.label}</strong><br /><span className={styles.muted}>{option.detail}（演示配置）</span></span>
              </label>
            ))}
          </fieldset>
          <fieldset className={styles.fieldset}>
            <legend>公开姓名策略</legend>
            <label className={styles.checkRow}>
              <input checked={rules.namePolicy === "CODES_ONLY"} name="namePolicy" onChange={() => setRules({ ...rules, namePolicy: "CODES_ONLY" })} type="radio" />
              <span><strong>只公开编号（推荐）</strong><br /><span className={styles.muted}>公开赛程只显示 P001、MS-001 等编号，姓名不离开服务端。</span></span>
            </label>
            <label className={styles.checkRow}>
              <input checked={rules.namePolicy === "DISPLAY_NAMES"} name="namePolicy" onChange={() => setRules({ ...rules, namePolicy: "DISPLAY_NAMES" })} type="radio" />
              <span><strong>公开姓名与代表队</strong><br /><span className={styles.muted}>学号和联系方式无论如何都不会公开。</span></span>
            </label>
          </fieldset>
          <div className={styles.fieldGrid}>
            <label className={styles.field}>
              <span>报名开始（{basics.timezone}）</span>
              <input
                onChange={(event) => setRules({ ...rules, registrationOpensAt: event.target.value })}
                type="datetime-local"
                value={rules.registrationOpensAt}
              />
              <small>可留空；报名是否开放最终由赛事阶段决定。</small>
            </label>
            <label className={styles.field}>
              <span>报名截止（{basics.timezone}）</span>
              <input
                onChange={(event) => setRules({ ...rules, registrationClosesAt: event.target.value })}
                type="datetime-local"
                value={rules.registrationClosesAt}
              />
              <small>截止后邀请链接不再接受提交，后台仍可补录。</small>
            </label>
            <label className={`${styles.field} ${styles.full}`}>
              <span>规程说明</span>
              <textarea
                maxLength={5000}
                onChange={(event) => setRules({ ...rules, regulations: event.target.value })}
                placeholder="参赛资格、兼项限制、报到时间等。报名页会原样展示。"
                value={rules.regulations}
              />
            </label>
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section className={styles.section} aria-labelledby={`${formId}-confirm`}>
          <div className={styles.sectionTitle}>
            <h2 id={`${formId}-confirm`}>确认创建</h2>
            <p>创建后是「草稿 · 筹备中」。开放报名、发布赛事都需要在赛事后台另行操作。</p>
          </div>
          <dl className={styles.facts}>
            <div><dt>赛事名称</dt><dd>{basics.name}</dd></div>
            <div><dt>访问路径</dt><dd>/public/{basics.slug}</dd></div>
            <div><dt>日期</dt><dd>{basics.startDate} 至 {basics.endDate}</dd></div>
            <div><dt>时区</dt><dd>{basics.timezone}</dd></div>
            <div><dt>规则</dt><dd>{ruleLabel}（演示配置）</dd></div>
            <div><dt>公开姓名</dt><dd>{rules.namePolicy === "CODES_ONLY" ? "只公开编号" : "公开姓名"}</dd></div>
            <div>
              <dt>报名窗口</dt>
              <dd>{rules.registrationOpensAt ? rules.registrationOpensAt.replace("T", " ") : "未设置"} — {rules.registrationClosesAt ? rules.registrationClosesAt.replace("T", " ") : "未设置"}</dd>
            </div>
            <div>
              <dt>项目（{competitions.length}）</dt>
              <dd>{competitions.map((item) => `${item.code} ${item.name}`).join("、")}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {error ? <p className={styles.alert} role="alert">{error}</p> : null}

      <div className={styles.actions}>
        {step > 0 ? (
          <ActionButton disabled={pending} onClick={() => { setError(null); setStep(step - 1); }} variant="secondary">
            上一步
          </ActionButton>
        ) : null}
        <ActionButton loading={pending} loadingLabel="正在创建…" type="submit">
          {step < STEPS.length - 1 ? "下一步" : "创建赛事"}
        </ActionButton>
      </div>
    </form>
  );
}
