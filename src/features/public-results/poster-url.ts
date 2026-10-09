/**
 * 浏览器访问赛事海报的地址。
 *
 * 海报由 `src/app/media/posters/[file]/route.ts` 从数据卷读取后返回，
 * 不走 `public/` 静态服务：生产模式只提供服务启动时已存在的 public 文件，启动后上传的海报会 404。
 */
export function posterUrl(posterPath: string) {
  return `/media/posters/${posterPath}`;
}
