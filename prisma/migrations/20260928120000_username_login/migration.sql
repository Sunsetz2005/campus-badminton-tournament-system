-- 用户名登录（Better Auth username 插件）：可选、唯一，插件写入前统一小写。
ALTER TABLE "users" ADD COLUMN "username" TEXT;
ALTER TABLE "users" ADD COLUMN "displayUsername" TEXT;
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
