"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";

type Side = "A" | "B";
type Outcome = "NORMAL" | "WO" | "RET" | "DSQ" | "ABANDONED";

const OUTCOMES: { value: Outcome; label: string; hint: string }[] = [
  { value: "NORMAL", label: "正常完赛", hint: "按逐局比分推出胜方。" },
  { value: "WO", label: "弃权（WO）", hint: "未开赛弃权/未到，不填任何比分。" },
  { value: "RET", label: "退赛（RET）", hint: "填写已完成局与中断局的实际比分，不补满。" },
  { value: "DSQ", label: "取消资格（DSQ）", hint: "填写实际比分，写明依据。" },
  { value: "ABANDONED", label: "终止待裁决", hint: "不产生胜方，阻止正式名次。" },
];

function errorText(error: { message: string; details?: Record<string, unknown> }) {
  const errors = (error.details as { errors?: string[] } | undefined)?.errors;
  return errors?.length ? errors.join("；") : error.message;
}

function parseScore(value: string) {
  return value.trim() === "" ? null : Number(value);
}

/**
 * 管理员补录一场比赛的逐局结果（仅结果记录）。只记录结果，不生成回合、发接发或换边过程；
 * 提交后是「待复核」，须由另一位裁判长独立复核锁定才进入名次与晋级。
 */
export function RecordResultForm({ slug, matchCode, bestOf, sideNames }: { slug: string; matchCode: string; bestOf: number; sideNames: Record<Side, string> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>("NORMAL");
  const [winnerSide, setWinnerSide] = useState<"" | Side>("");
  const [games, setGames] = useState<{ a: string; b: string }[]>(Array.from({ length: bestOf }, () => ({ a: "", b: "" })));
  const [partial, setPartial] = useState({ a: "", b: "" });
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return <ActionButton onClick={() => setOpen(true)} size="sm" variant="secondary">补录结果</ActionButton>;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const filled = games
      .map((game) => ({ a: parseScore(game.a), b: parseScore(game.b) }))
      .filter((game) => game.a !== null || game.b !== null);
    if (filled.some((game) => game.a === null || game.b === null || Number.isNaN(game.a) || Number.isNaN(game.b))) {
      setError("每一局都要同时填写双方比分。");
      return;
    }
    const partialA = parseScore(partial.a);
    const partialB = parseScore(partial.b);
    setPending(true);
    setError(null);
    const result = await sendJson<{ revision: number }>(`/api/admin/tournaments/${slug}/matches/${matchCode}/result-only`, "POST", {
      outcome,
      winnerSide: outcome === "NORMAL" || outcome === "ABANDONED" ? null : winnerSide || null,
      games: outcome === "WO" ? [] : filled,
      partial: (outcome === "RET" || outcome === "DSQ" || outcome === "ABANDONED") && partialA !== null && partialB !== null ? { a: partialA, b: partialB } : null,
      reason,
    });
    setPending(false);
    if (!result.ok) {
      setError(errorText(result.error));
      return;
    }
    setOpen(false);
    router.refresh();
  }

  const special = outcome !== "NORMAL";
  return (
    <form aria-label={`补录 ${matchCode} 的结果`} className={styles.form} onSubmit={submit}>
      <p className={styles.info}>仅结果记录：只保存逐局比分与结局，不伪造回合与发接发过程；提交后须另一位裁判长复核锁定。</p>
      <div className={styles.grid}>
        <label className={styles.field}>
          <span>结局</span>
          <select onChange={(event) => setOutcome(event.target.value as Outcome)} value={outcome}>
            {OUTCOMES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <small>{OUTCOMES.find((item) => item.value === outcome)?.hint}</small>
        </label>
        {special && outcome !== "ABANDONED" ? (
          <label className={styles.field}>
            <span>胜方</span>
            <select onChange={(event) => setWinnerSide(event.target.value as "" | Side)} value={winnerSide}>
              <option value="">请选择</option>
              <option value="A">{sideNames.A}</option>
              <option value="B">{sideNames.B}</option>
            </select>
          </label>
        ) : null}
      </div>
      {outcome !== "WO" ? (
        <fieldset className={styles.fieldset}>
          <legend>已完成的各局（{sideNames.A} : {sideNames.B}）</legend>
          <div className={styles.grid}>
            {games.map((game, index) => (
              <div className={styles.actions} key={index}>
                <span className={styles.rubberNo}>第 {index + 1} 局</span>
                <input aria-label={`第 ${index + 1} 局 A 方比分`} inputMode="numeric" onChange={(event) => setGames(games.map((item, at) => (at === index ? { ...item, a: event.target.value } : item)))} size={3} value={game.a} />
                <span>:</span>
                <input aria-label={`第 ${index + 1} 局 B 方比分`} inputMode="numeric" onChange={(event) => setGames(games.map((item, at) => (at === index ? { ...item, b: event.target.value } : item)))} size={3} value={game.b} />
              </div>
            ))}
          </div>
          {special ? (
            <div className={styles.actions}>
              <span className={styles.rubberNo}>中断局</span>
              <input aria-label="中断局 A 方比分" inputMode="numeric" onChange={(event) => setPartial({ ...partial, a: event.target.value })} size={3} value={partial.a} />
              <span>:</span>
              <input aria-label="中断局 B 方比分" inputMode="numeric" onChange={(event) => setPartial({ ...partial, b: event.target.value })} size={3} value={partial.b} />
              <span className={styles.hint}>没有中断局可留空</span>
            </div>
          ) : null}
        </fieldset>
      ) : null}
      <label className={styles.field}>
        <span>补录依据（必填，记入审计）</span>
        <input maxLength={200} onChange={(event) => setReason(event.target.value)} placeholder="例如：纸质记分表 07 号，11 月 2 日下午 3 号场" value={reason} />
      </label>
      {error ? <p className={styles.alert} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <ActionButton loading={pending} loadingLabel="正在提交…" type="submit">提交待复核</ActionButton>
        <ActionButton disabled={pending} onClick={() => setOpen(false)} variant="ghost">取消</ActionButton>
      </div>
    </form>
  );
}

/** 裁判长复核待复核的仅结果记录：锁定或退回。补录人不能自己复核（服务端校验）。 */
export function ReviewResultPanel({ slug, matchCode, revision }: { slug: string; matchCode: string; revision: number }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<"CONFIRM" | "RETURN" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "CONFIRM" | "RETURN") {
    setPending(action);
    setError(null);
    const result = await sendJson(`/api/admin/tournaments/${slug}/matches/${matchCode}/result-only/review`, "POST", { action, expectedRevision: revision, reason });
    setPending(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className={styles.form}>
      <label className={styles.field}>
        <span>复核意见（必填）</span>
        <input maxLength={200} onChange={(event) => setReason(event.target.value)} value={reason} />
      </label>
      {error ? <p className={styles.alert} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <ActionButton disabled={pending !== null} loading={pending === "CONFIRM"} loadingLabel="正在锁定…" onClick={() => void act("CONFIRM")} size="sm">复核锁定</ActionButton>
        <ActionButton disabled={pending !== null} loading={pending === "RETURN"} loadingLabel="正在退回…" onClick={() => void act("RETURN")} size="sm" variant="danger">退回</ActionButton>
      </div>
    </div>
  );
}

interface Impact {
  blocked: boolean;
  effects: string[];
  blockers: string[];
}

/**
 * 已确认结果的更正：先看影响预览，再决定。
 * - 仅结果记录：影响允许时在这里受控重开；
 * - 裁判台逐分记分：在裁判台用「受控重开」执行，这里只给出预览；
 * - 后续比赛已开始（被阻止）：不自动改写，登记人工处置决定。
 */
export function CorrectionPanel({
  slug,
  matchCode,
  source,
  revision,
}: {
  slug: string;
  matchCode: string;
  source: "LIVE" | "RESULT_ONLY";
  revision: number | null;
}) {
  const router = useRouter();
  const [impact, setImpact] = useState<Impact | null>(null);
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<"MAINTAIN" | "OFFLINE_RULING">("MAINTAIN");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadImpact() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(matchCode)}/result-impact?action=REOPEN`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) setError(payload?.error?.message ?? "无法取得更正影响。");
      else setImpact(payload as Impact);
    } catch {
      setError("网络中断，未能取得更正影响。");
    }
    setLoading(false);
  }

  async function reopen(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await sendJson(`/api/admin/tournaments/${slug}/matches/${matchCode}/result-only/review`, "POST", { action: "REOPEN", expectedRevision: revision, reason });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    router.refresh();
  }

  async function dispose(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await sendJson(`/api/admin/tournaments/${slug}/matches/${matchCode}/disposition`, "POST", { decision, reason });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setImpact(null);
    setReason("");
    router.refresh();
  }

  if (!impact) {
    return (
      <div className={styles.actions}>
        <ActionButton loading={loading} loadingLabel="正在计算影响…" onClick={() => void loadImpact()} size="sm" variant="secondary">更正前查看影响</ActionButton>
        {error ? <p className={styles.alert} role="alert">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className={styles.form} data-testid={`impact-${matchCode}`}>
      {impact.effects.length ? (
        <div className={styles.info}>
          重开更正将会：
          <ul>{impact.effects.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      ) : <p className={styles.info}>重开这场结果不会影响其他对阵或名次。</p>}
      {impact.blocked ? (
        <>
          <div className={styles.alert}>
            不能自动更正：
            <ul>{impact.blockers.map((item) => <li key={item}>{item}</li>)}</ul>
            系统不会自动换人、抹分或覆盖历史。请由裁判长决定维持原结果，或在线下裁决（暂停、取消、重赛）后登记。
          </div>
          <form className={styles.form} onSubmit={dispose}>
            <div className={styles.grid}>
              <label className={styles.field}>
                <span>处置决定</span>
                <select onChange={(event) => setDecision(event.target.value as typeof decision)} value={decision}>
                  <option value="MAINTAIN">维持原结果（记录争议）</option>
                  <option value="OFFLINE_RULING">线下裁决（暂停/取消/重赛另行执行）</option>
                </select>
              </label>
            </div>
            <label className={styles.field}>
              <span>处置依据（必填，记入审计）</span>
              <input maxLength={200} onChange={(event) => setReason(event.target.value)} value={reason} />
            </label>
            {error ? <p className={styles.alert} role="alert">{error}</p> : null}
            <div className={styles.actions}>
              <ActionButton loading={pending} loadingLabel="正在登记…" type="submit" variant="danger">登记人工处置</ActionButton>
              <ActionButton disabled={pending} onClick={() => setImpact(null)} variant="ghost">关闭</ActionButton>
            </div>
          </form>
        </>
      ) : source === "RESULT_ONLY" && revision ? (
        <form className={styles.form} onSubmit={reopen}>
          <label className={styles.field}>
            <span>更正原因（必填，旧结果保留为被替代版本）</span>
            <input maxLength={200} onChange={(event) => setReason(event.target.value)} value={reason} />
          </label>
          {error ? <p className={styles.alert} role="alert">{error}</p> : null}
          <div className={styles.actions}>
            <ActionButton loading={pending} loadingLabel="正在重开…" type="submit" variant="danger">确认重开更正</ActionButton>
            <ActionButton disabled={pending} onClick={() => setImpact(null)} variant="ghost">关闭</ActionButton>
          </div>
        </form>
      ) : (
        <div className={styles.actions}>
          <p className={styles.hint}>这场结果由裁判台逐分记分产生：请在裁判台接管后使用「受控重开」，同一事务内按上述影响撤回。</p>
          <ActionButton onClick={() => setImpact(null)} size="sm" variant="ghost">关闭</ActionButton>
        </div>
      )}
    </div>
  );
}

/** 裁判长处理特殊结果：排除不能完成本组比赛的报名单位（及其全部对阵贡献），或取消排除。 */
export function ExclusionPanel({
  slug,
  competitionCode,
  groupCode,
  candidates,
  excluded,
}: {
  slug: string;
  competitionCode: string;
  groupCode: string;
  candidates: { id: string; name: string }[];
  excluded: { entryId: string; name: string; reason: string }[];
}) {
  const router = useRouter();
  const [entryId, setEntryId] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/admin/tournaments/${slug}/competitions/${competitionCode}/groups/${groupCode}/exclusions`;

  async function send(body: Record<string, unknown>) {
    setPending(true);
    setError(null);
    const result = await sendJson(url, "POST", body);
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return false;
    }
    router.refresh();
    return true;
  }

  return (
    <div className={styles.form}>
      {excluded.length ? (
        <ul className={styles.chips}>
          {excluded.map((item) => (
            <li key={item.entryId}>
              <span>已排除：{item.name}（{item.reason}）</span>
              <ActionButton disabled={pending} onClick={() => void send({ entryId: item.entryId, action: "REMOVE" })} size="sm" variant="ghost">取消排除</ActionButton>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className={styles.form}
        onSubmit={async (event) => {
          event.preventDefault();
          if (await send({ entryId, action: "ADD", reason })) {
            setEntryId("");
            setReason("");
          }
        }}
      >
        <div className={styles.grid}>
          <label className={styles.field}>
            <span>排除报名单位</span>
            <select onChange={(event) => setEntryId(event.target.value)} value={entryId}>
              <option value="">请选择</option>
              {candidates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span>原因（必填）</span>
            <input maxLength={200} onChange={(event) => setReason(event.target.value)} placeholder="例如：赛前伤病弃权，不能完成本组比赛" value={reason} />
          </label>
        </div>
        {error ? <p className={styles.alert} role="alert">{error}</p> : null}
        <div className={styles.actions}>
          <ActionButton disabled={!entryId} loading={pending} loadingLabel="正在记录…" type="submit" variant="secondary">排除并重新计算</ActionButton>
          <span className={styles.hint}>排除只影响名次统计：原比赛、比分与审计全部保留，其他人对该单位的胜负也同步不计。</span>
        </div>
      </form>
    </div>
  );
}

/** 发布名次榜单的新版本；历史版本保留。 */
export function PublishStandingsPanel({ slug, competitionCode, disabledReason }: { slug: string; competitionCode: string; disabledReason: string | null }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const result = await sendJson<{ version: number }>(`/api/admin/tournaments/${slug}/competitions/${competitionCode}/standings/publish`, "POST", { note: note || null });
    setPending(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.error.message });
      return;
    }
    setMessage({ ok: true, text: `已发布第 ${result.data.version} 版榜单。` });
    setNote("");
    router.refresh();
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>
        <span>发布说明（选填）</span>
        <input maxLength={200} onChange={(event) => setNote(event.target.value)} placeholder="例如：更正决赛比分后重新发布" value={note} />
      </label>
      {message ? <p className={message.ok ? styles.success : styles.alert} role={message.ok ? "status" : "alert"}>{message.text}</p> : null}
      <div className={styles.actions}>
        <ActionButton disabled={Boolean(disabledReason)} loading={pending} loadingLabel="正在发布…" type="submit">发布榜单新版本</ActionButton>
        {disabledReason ? <span className={styles.hint}>{disabledReason}</span> : null}
      </div>
    </form>
  );
}
