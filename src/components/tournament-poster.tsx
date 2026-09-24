import type { PublicTournamentCard } from "@/features/public-results/model";

/**
 * 缺少海报时的确定性占位卡。
 *
 * 颜色只由 slug 决定，因此同一赛事每次渲染完全一致，不随机、不外链、不加载第三方资源。
 */
function hueFromSlug(slug: string) {
  // FNV-1a。取模 360 的乘法散列会把相似 slug 挤到相邻色相
  // （spring-campus-2026 与 winter-campus-2026 会得到几乎一样的绿），
  // 先算满 32 位再折算色相，相邻赛事的占位卡才能明显区分。
  let hash = 0x811c9dc5;
  for (let index = 0; index < slug.length; index += 1) {
    hash ^= slug.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/**
 * 占位卡上的两字缩写。跳过开头的年份与空白，优先取有信息量的汉字，
 * 例如「2026 校园羽毛球春季联赛（模拟）」取「校园」而不是「20」。
 */
function initialsFor(name: string) {
  const meaningful = [...name].filter((character) => /[\p{Script=Han}\p{Letter}]/u.test(character));
  const source = meaningful.length ? meaningful : [...name.trim()];
  return source.slice(0, 2).join("") || "赛";
}

export interface TournamentPosterProps {
  tournament: Pick<PublicTournamentCard, "name" | "posterAlt" | "posterPath" | "slug">;
}

export function TournamentPoster({ tournament }: TournamentPosterProps) {
  if (tournament.posterPath) {
    return (
      // 同源静态文件，不经过图片优化器，也不需要 images.remotePatterns。
      // eslint-disable-next-line @next/next/no-img-element
      <img
        alt={tournament.posterAlt ?? `${tournament.name} 赛事海报`}
        className="tournament-poster"
        height={99}
        loading="lazy"
        src={`/posters/${tournament.posterPath}`}
        width={176}
      />
    );
  }

  const hue = hueFromSlug(tournament.slug);
  return (
    <div
      aria-hidden="true"
      className="tournament-poster tournament-poster-fallback"
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 42% 28%), hsl(${(hue + 38) % 360} 46% 44%))`,
      }}
    >
      <span>{initialsFor(tournament.name)}</span>
    </div>
  );
}
