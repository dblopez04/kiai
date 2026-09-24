// The tournament ratings card on the matches page: o!TR and Skill Issue side by side.

import { html } from "hono/html";
import { OTR_SERVER, otrProfileUrl, type OtrRating, type SipRating, type SkillIssueRating } from "../ratings/providers.ts";
import type { ProviderState, RatingsOverview } from "../ratings/service.ts";
import { fmt } from "./views.ts";

type Html = ReturnType<typeof html>;

const rank = (n: number) => (n > 0 ? `#${fmt.number(n)}` : "—");
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${fmt.number(Math.abs(Math.round(n)))}`;
// Written the way o!TR's site does: "Gold II"; Elite Grandmaster has no sub-tiers.
const subTierLabel = (tier: string, sub: number | null) =>
  sub && tier !== "Elite Grandmaster" ? `${tier} ${["I", "II", "III"][sub - 1] ?? sub}` : tier;

function status<T>(p: ProviderState<T>, name: string): Html | string {
  const parts: (Html | string)[] = [];
  if (p.refreshing) parts.push(html`<span class="muted small">Updating…</span>`);
  if (p.error) parts.push(html`<p class="alert small">${p.data || p.unrated ? `Couldn't update ${name}` : `Couldn't fetch ${name}`}: ${p.error}</p>`);
  if (p.fetched_at) parts.push(html`<p class="muted small">Updated ${fmt.dateTime(p.fetched_at)}</p>`);
  return html`${parts}`;
}

function otrSection(p: ProviderState<OtrRating>): Html {
  const title = html`<h3><a href="${p.data ? otrProfileUrl(p.data) : OTR_SERVER}" target="_blank" rel="noopener noreferrer">o!TR</a></h3>`;
  if (!p.configured) {
    return html`<div class="rating-source">${title}
      <p class="small">Sign in at <a href="${OTR_SERVER}" target="_blank" rel="noopener noreferrer">otr.stagec.net</a>, create a key under Settings → API keys, and set <code>OTR_API_KEY</code> in <code>.env</code>.</p>
    </div>`;
  }
  const r = p.data;
  if (!r) {
    return html`<div class="rating-source">${title}
      ${p.unrated ? html`<p class="muted">o!TR has no osu! rating for you yet. It only counts matches from tournaments it has verified.</p>` : ""}
      ${!p.unrated && !p.error ? html`<p class="muted">Fetching…</p>` : ""}
      ${status(p, "o!TR")}
    </div>`;
  }
  const nextTier = r.next_tier && r.rating_for_next_tier !== null && r.rating_for_next_tier > 0
    ? html`<span class="muted small">${fmt.number(Math.ceil(r.rating_for_next_tier))} to ${subTierLabel(r.next_tier, r.next_sub_tier)}</span>`
    : "";
  return html`<div class="rating-source">${title}
    <div class="stats">
      <div class="stat"><span class="label">Rating</span><strong>${fmt.number(Math.round(r.rating))} TR</strong><span class="small">${subTierLabel(r.tier, r.sub_tier)}${r.provisional ? html` <span class="chip" title="Too few matches for o!TR to be sure yet">provisional</span>` : ""}</span>${nextTier}</div>
      <div class="stat"><span class="label">Global</span><strong>${rank(r.global_rank)}</strong><span class="muted small">top ${(100 - r.percentile).toFixed(2)}%</span></div>
      <div class="stat"><span class="label">Country</span><strong>${rank(r.country_rank)}</strong></div>
      <div class="stat"><span class="label">Last 30 days</span><strong class="${r.change_30d > 0 ? "up" : r.change_30d < 0 ? "down" : ""}">${signed(r.change_30d)}</strong><span class="muted small">peak ${fmt.number(Math.round(r.peak))}</span></div>
      <div class="stat"><span class="label">Verified</span><strong>${fmt.number(r.tournaments)}</strong><span class="muted small">tournaments · ${fmt.number(r.matches)} matches${r.win_rate !== null ? ` · ${(r.win_rate * 100).toFixed(0)}% won` : ""}</span></div>
    </div>
    ${status(p, "o!TR")}
  </div>`;
}

function sipRow(r: SipRating): Html {
  return html`<tr>
    <td>${r.name}</td>
    <td class="r"><strong>${fmt.number(r.value)}</strong></td>
    <td class="r">${fmt.stars(r.sr)}</td>
    <td class="r">${rank(r.global_rank)}</td>
    <td class="r">${rank(r.country_rank)}</td>
  </tr>`;
}

function skillIssueSection(p: ProviderState<SkillIssueRating>): Html {
  const title = html`<h3>Skill Issue</h3>`;
  if (!p.configured) {
    return html`<div class="rating-source">${title}
      <p class="small">Skill Issue's API only answers callers its author has allowed. Ask JustRoxy on the <a href="https://discord.gg/3sPDrRT52z" target="_blank" rel="noopener noreferrer">Skill Issue Discord</a> for a source key and set <code>SKILLISSUE_SOURCE</code> in <code>.env</code>. Until then, the bot's <code>rating</code> command shows it in Discord.</p>
    </div>`;
  }
  const s = p.data;
  if (!s) {
    return html`<div class="rating-source">${title}
      ${p.unrated ? html`<p class="muted">Skill Issue hasn't rated you yet.</p>` : ""}
      ${!p.unrated && !p.error ? html`<p class="muted">Fetching…</p>` : ""}
      ${status(p, "Skill Issue")}
    </div>`;
  }
  const r = s.rating;
  const breakdown = [...s.mods, ...s.skillsets];
  return html`<div class="rating-source">${title}
    <div class="stats">
      <div class="stat"><span class="label">Rating</span><strong>${fmt.number(r.value)} SIP</strong><span class="muted small" title="The star rating Skill Issue expects you to handle">${fmt.stars(r.sr)}</span></div>
      <div class="stat"><span class="label">Global</span><strong>${rank(r.global_rank)}</strong></div>
      <div class="stat"><span class="label">Country</span><strong>${rank(r.country_rank)}</strong></div>
      <div class="stat"><span class="label">Style</span><strong>${Math.round(r.accuracy * 100)}% acc</strong><span class="muted small">${Math.round((1 - r.accuracy) * 100)}% combo</span></div>
    </div>
    ${breakdown.length
      ? html`<details>
          <summary>By mod and skillset</summary>
          <div class="tablewrap"><table class="scores compact">
            <thead><tr><th></th><th class="r">SIP</th><th class="r">Stars</th><th class="r">Global</th><th class="r">Country</th></tr></thead>
            <tbody>${s.mods.map(sipRow)}${s.skillsets.length && s.mods.length ? html`<tr><td colspan="5" class="muted small">Skillsets</td></tr>` : ""}${s.skillsets.map(sipRow)}</tbody>
          </table></div>
        </details>`
      : ""}
    ${status(p, "Skill Issue")}
  </div>`;
}

export function ratingsPanel(overview: RatingsOverview): Html {
  const anyConfigured = overview.otr.configured || overview.skillissue.configured;
  return html`<section class="card" aria-label="Tournament ratings">
    <div class="row wrap">
      <h2 class="grow">Tournament ratings</h2>
      ${anyConfigured
        ? html`<form method="post" action="/matches/ratings/refresh"><button>Refresh</button></form>`
        : ""}
    </div>
    <div class="grid2">${otrSection(overview.otr)}${skillIssueSection(overview.skillissue)}</div>
  </section>`;
}
