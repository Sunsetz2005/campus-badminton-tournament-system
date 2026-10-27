-- 赛务口径 W-6（2026-10-27）：团体出场名单可以把某个小场空着，表示本方认输该小场
-- （人数不足等），按 BWF GCR 16.3.8「认输方不再得分」计入，对抗照常结算。
ALTER TABLE "fixture_lineups" ADD COLUMN "concededOrders" INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE "fixture_lineups"
  ADD CONSTRAINT "fixture_lineups_conceded_orders_check" CHECK (
    array_position("concededOrders", NULL) IS NULL
    AND 1 <= ALL ("concededOrders") AND 9 >= ALL ("concededOrders")
  );
