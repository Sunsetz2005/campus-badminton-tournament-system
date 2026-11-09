// 复判探针（非产品测试）：把 Date 整体平移到 2026-10-30 00:00Z 起「继续走的时钟」，
// 用于判断 tests/integration/schedule.test.ts 的失败是否只因硬编码比赛日（2026-11-02/03）已经过去。
const RealDate = Date;
const offset = new RealDate("2026-10-30T00:00:00Z").getTime() - RealDate.now();
class ShiftedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...(args as [string | number | Date]));
  }
  static now() {
    return RealDate.now() + offset;
  }
}
globalThis.Date = ShiftedDate as DateConstructor;
