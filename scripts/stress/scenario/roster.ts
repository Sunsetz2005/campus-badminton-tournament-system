/**
 * 生成参赛名单：学院、选手（姓名、学号、性别、所属学院）、各项目报名单位与团体名单。
 * 姓名由常见姓与随机字拼成，不对应任何真实人物；学号带运行标签，保证同一赛事内唯一、跨运行可区分。
 *
 * 兼项：按 multiEventRatio 让一部分人报两个以上个人项目；团体队员按 teamCrossoverRatio 复用已报个人项目的人，
 * 从而制造真实的人员时间冲突（§3.1）。
 */
import type { EventKind, EventPlan, LevelConfig, RubberKind, TeamPlan } from "../config/levels";
import type { Rng } from "../core/rng";

export type Gender = "MALE" | "FEMALE";

export interface Person {
  key: string;
  displayName: string;
  studentId: string;
  gender: Gender;
  unit: string;
}

export interface PlannedEntry {
  key: string;
  eventCode: string;
  members: Person[];
  unit: string;
}

export interface PlannedTeam {
  key: string;
  unit: string;
  name: string;
  members: { person: Person; rubberKinds: RubberKind[] }[];
}

export interface TournamentRoster {
  persons: Person[];
  entries: Map<string, PlannedEntry[]>;
  teams: PlannedTeam[];
}

const SURNAMES = "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤".split("");
const GIVEN_MALE = "伟强磊军洋勇杰涛明超辉鹏华飞斌宇浩凯健俊帆帅旭晨昊阳博睿翔泽轩然哲铭峰锐鑫".split("");
const GIVEN_FEMALE = "芳娜敏静丽艳娟霞婷雪琳慧颖倩洁瑶佳欣怡萱悦妍璐菲蕾彤晴雯薇琪梦曦婧岚".split("");
const UNIT_NAMES = [
  "数学科学学院", "物理学院", "化学学院", "生命科学学院", "计算机学院", "电子工程学院", "机械工程学院", "土木工程学院",
  "经济学院", "管理学院", "法学院", "文学院", "外国语学院", "新闻传播学院", "艺术学院", "体育科学学院",
  "医学院", "药学院", "环境学院", "材料学院",
];

export const RUBBER_GENDER: Record<RubberKind, Gender | "MIXED"> = { MS: "MALE", WS: "FEMALE", MD: "MALE", WD: "FEMALE", XD: "MIXED" };
const EVENT_SIZE: Record<EventKind, number> = { MS: 1, WS: 1, MD: 2, WD: 2, XD: 2 };

export function unitNames(count: number) {
  if (count > UNIT_NAMES.length) throw new Error(`学院数最多 ${UNIT_NAMES.length}。`);
  return UNIT_NAMES.slice(0, count);
}

class PersonPool {
  persons: Person[] = [];
  private names = new Set<string>();
  private sequence = 0;

  constructor(private rng: Rng, private runTag: string, private tournamentKey: string) {}

  create(gender: Gender, unit: string): Person {
    let name = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const given = gender === "MALE" ? GIVEN_MALE : GIVEN_FEMALE;
      name = this.rng.pick(SURNAMES) + this.rng.pick(given) + (this.rng.chance(0.6) ? this.rng.pick(given) : "");
      if (!this.names.has(name)) break;
    }
    this.names.add(name);
    this.sequence += 1;
    const person: Person = {
      key: `${this.tournamentKey}-P${String(this.sequence).padStart(4, "0")}`,
      displayName: name,
      studentId: `${this.runTag}${this.tournamentKey}${String(this.sequence).padStart(4, "0")}`,
      gender,
      unit,
    };
    this.persons.push(person);
    return person;
  }
}

function genderFor(kind: EventKind, slot: number): Gender {
  if (kind === "MS" || kind === "MD") return "MALE";
  if (kind === "WS" || kind === "WD") return "FEMALE";
  return slot === 0 ? "MALE" : "FEMALE";
}

/**
 * 一个赛事的名单。`busy` 记录每人已报的项目，复用时避开同一项目。
 */
export function generateRoster(
  rng: Rng,
  level: LevelConfig,
  plan: { key: string; events: EventPlan[]; team: TeamPlan | null },
  runTag: string,
): TournamentRoster {
  const units = unitNames(level.units);
  const pool = new PersonPool(rng.fork("names"), runTag, plan.key);
  const eventsOf = new Map<string, Set<string>>();
  const entries = new Map<string, PlannedEntry[]>();

  const reusable = (gender: Gender, unit: string, eventCode: string, taken: Set<string>) =>
    pool.persons.filter(
      (person) => person.gender === gender && person.unit === unit && !taken.has(person.key) && !(eventsOf.get(person.key)?.has(eventCode)),
    );

  for (const event of plan.events) {
    const pick = rng.fork(`event:${event.code}`);
    const list: PlannedEntry[] = [];
    const taken = new Set<string>();
    for (let index = 0; index < event.entries; index += 1) {
      // 学院按轮转分配并加一点随机，保证同单位回避有冲突可测。
      const unit = pick.chance(0.8) ? units[index % units.length] : pick.pick(units);
      const members: Person[] = [];
      for (let slot = 0; slot < EVENT_SIZE[event.kind]; slot += 1) {
        const gender = genderFor(event.kind, slot);
        const candidates = reusable(gender, unit, event.code, taken);
        const person = candidates.length && pick.chance(level.multiEventRatio) ? pick.pick(candidates) : pool.create(gender, unit);
        taken.add(person.key);
        members.push(person);
      }
      for (const person of members) {
        const set = eventsOf.get(person.key) ?? new Set<string>();
        set.add(event.code);
        eventsOf.set(person.key, set);
      }
      list.push({ key: `${plan.key}-${event.code}-${String(index + 1).padStart(2, "0")}`, eventCode: event.code, members, unit });
    }
    entries.set(event.code, list);
  }

  const teams: PlannedTeam[] = [];
  if (plan.team) {
    const team = plan.team;
    const pick = rng.fork(`team:${team.code}`);
    const needs = lineupNeeds(team.rubbers);
    for (let index = 0; index < team.teams; index += 1) {
      const unit = units[index % units.length];
      const size = pick.int(Math.max(team.rosterSize[0], needs.MALE + needs.FEMALE), team.rosterSize[1]);
      const members: PlannedTeam["members"] = [];
      const used = new Set<string>();
      const add = (gender: Gender) => {
        const candidates = pool.persons.filter((person) => person.gender === gender && person.unit === unit && !used.has(person.key));
        const person = candidates.length && pick.chance(level.teamCrossoverRatio) ? pick.pick(candidates) : pool.create(gender, unit);
        used.add(person.key);
        members.push({ person, rubberKinds: team.rubbers.filter((kind) => RUBBER_GENDER[kind] === "MIXED" || RUBBER_GENDER[kind] === gender) });
      };
      for (let count = 0; count < needs.MALE; count += 1) add("MALE");
      for (let count = 0; count < needs.FEMALE; count += 1) add("FEMALE");
      while (members.length < size) add(pick.chance(0.5) ? "MALE" : "FEMALE");
      teams.push({ key: `${plan.key}-T${String(index + 1).padStart(2, "0")}`, unit, name: unit, members });
    }
  }

  return { persons: pool.persons, entries, teams };
}

/** 一场对抗所有小场同时上场所需的男女人数（每个小场用不同队员，避免同一人时间重叠）。 */
export function lineupNeeds(rubbers: readonly RubberKind[]) {
  const needs = { MALE: 0, FEMALE: 0 };
  for (const kind of rubbers) {
    if (kind === "MS") needs.MALE += 1;
    else if (kind === "WS") needs.FEMALE += 1;
    else if (kind === "MD") needs.MALE += 2;
    else if (kind === "WD") needs.FEMALE += 2;
    else {
      needs.MALE += 1;
      needs.FEMALE += 1;
    }
  }
  return needs;
}
