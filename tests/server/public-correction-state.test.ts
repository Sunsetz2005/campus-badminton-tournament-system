import { describe, expect, it } from "vitest";

import { projectCorrectionState } from "@/server/services/public-projection";

type Row = Parameters<typeof projectCorrectionState>[0][number];

const rows = (...statuses: Row["status"][]): Row[] => statuses.map((status, index) => ({ revision: index + 1, status }));

describe("AUD-005 公开更正标记", () => {
  it("从未锁定或仅首次锁定：无更正", () => {
    expect(projectCorrectionState([])).toBe("NONE");
    expect(projectCorrectionState(rows("PENDING"))).toBe("NONE");
    expect(projectCorrectionState(rows("LOCKED"))).toBe("NONE");
    // 锁定前的退回没有对外发布过，不是更正。
    expect(projectCorrectionState(rows("RETURNED", "PENDING"))).toBe("NONE");
    expect(projectCorrectionState(rows("RETURNED", "LOCKED"))).toBe("NONE");
  });

  it("第一次重开后、新修订提交前只有一条 SUPERSEDED：更正处理中", () => {
    expect(projectCorrectionState(rows("SUPERSEDED"))).toBe("UNDER_REVIEW");
  });

  it("重开后的新修订待复核、被退回或再次被重开：更正处理中", () => {
    expect(projectCorrectionState(rows("SUPERSEDED", "PENDING"))).toBe("UNDER_REVIEW");
    expect(projectCorrectionState(rows("SUPERSEDED", "RETURNED"))).toBe("UNDER_REVIEW");
    expect(projectCorrectionState(rows("SUPERSEDED", "SUPERSEDED"))).toBe("UNDER_REVIEW");
  });

  it("重开后重新锁定：已公开更正，与输入顺序无关", () => {
    expect(projectCorrectionState(rows("SUPERSEDED", "LOCKED"))).toBe("CORRECTED");
    expect(projectCorrectionState([...rows("SUPERSEDED", "SUPERSEDED", "LOCKED")].reverse())).toBe("CORRECTED");
  });
});
