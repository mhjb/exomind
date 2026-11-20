import { useEffect, useState } from 'react';
import type { AppStatus, UsageSummary } from '../../shared/types';
import { api } from './api';
import { Icon } from './icons';
import { cx, fmtDate, fmtTokens, fmtUsd, href } from './util';

export function UsageView({ tick, status }: { tick: number; status: AppStatus | null }) {
  const [u, setU] = useState<UsageSummary | null>(null);
  const [all, setAll] = useState(false);

  // Refresh whenever notes change or a job finishes.
  useEffect(() => {
    api.usage().then(setU);
  }, [tick, status?.working, status?.monthSpend]);

  if (!u) return <div className="page" />;
  const pct = u.budget ? Math.min(1, u.month / u.budget) : 0;
  const rows = all ? u.notes : u.notes.slice(0, 25);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Usage</h1>
          <p className="muted">
            What the models have cost, worked out from the token counts on every API call at list prices (US$). Your{' '}
            <a href="https://platform.openai.com/usage" target="_blank" rel="noreferrer">
              OpenAI
            </a>{' '}
            and{' '}
            <a href="https://platform.claude.com/settings/billing" target="_blank" rel="noreferrer">
              Anthropic
            </a>{' '}
            consoles have the authoritative bills.
          </p>
        </div>
        <div className="page-actions">
          <a className="btn" href="#/settings">
            <Icon name="settings" size={14} /> Limits
          </a>
        </div>
      </header>

      {status?.overBudget && (
        <div className="banner banner-warn">
          <Icon name="alert" size={16} />
          <div>
            <strong>Monthly budget reached.</strong> Processing is paused until next month, or until you raise the budget in{' '}
            <a href="#/settings">Settings</a>.
          </div>
        </div>
      )}

      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">This month</div>
          <div className="stat-value">{fmtUsd(u.month, 2)}</div>
          {u.budget > 0 ? (
            <>
              <div className="budget-bar" role="meter" aria-valuemin={0} aria-valuemax={u.budget} aria-valuenow={u.month} aria-label="Share of monthly budget used">
                <i className={cx(pct >= 1 ? 'over' : pct >= 0.8 && 'near')} style={{ width: `${pct * 100}%` }} />
              </div>
              <div className="stat-sub">of {fmtUsd(u.budget, 0)} budget</div>
            </>
          ) : (
            <div className="stat-sub">no budget set</div>
          )}
        </div>
        <div className="stat">
          <div className="stat-label">Today</div>
          <div className="stat-value">{fmtUsd(u.today, 2)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Per note, on average</div>
          <div className="stat-value">{fmtUsd(u.avgPerNote)}</div>
          <div className="stat-sub">{u.notes.length} notes</div>
        </div>
        <div className="stat">
          <div className="stat-label">All time</div>
          <div className="stat-value">{fmtUsd(u.allTime, 2)}</div>
          <div className="stat-sub">{u.calls} model calls</div>
        </div>
      </div>

      {/* House chart frame: title, subtitle, chart, source line */}
      <section className="q-section chart">
        <div>
          <h2 className="chart-title">Spending on models each day, last 30 days</h2>
          <p className="chart-sub">US dollars at list prices, worked out from the tokens each call used</p>
        </div>
        <DailyBars days={u.days} />
        <p className="chart-foot">
          <span>Data: Exo-mind's log of model calls</span>
        </p>
      </section>

      <section className="q-section">
        <div className="section-h-row">
          <h2 className="section-h">By note</h2>
          {u.notes.length > 25 && (
            <button className="btn btn-sm" onClick={() => setAll(!all)}>
              {all ? 'Show recent' : `Show all ${u.notes.length}`}
            </button>
          )}
        </div>
        {u.notes.length === 0 ? (
          <p className="muted">Nothing yet. Costs are recorded from now on, so notes made before this update show no cost.</p>
        ) : (
          <table className="usage-table">
            <thead>
              <tr>
                <th>Note</th>
                <th className="num">Tokens in</th>
                <th className="num">Tokens out</th>
                <th className="num">Calls</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.slug}>
                  <td>
                    {n.deleted ? <span className="muted">{n.title} (deleted)</span> : <a href={href({ slug: n.slug })}>{n.title}</a>}
                    <div className="usage-date">{fmtDate(n.last)}</div>
                  </td>
                  <td className="num">{fmtTokens(n.input)}</td>
                  <td className="num">{fmtTokens(n.output)}</td>
                  <td className="num">{n.calls}</td>
                  <td className="num strong">{fmtUsd(n.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="q-section">
        <h2 className="section-h">Prices used</h2>
        <table className="usage-table prices">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Input / M tokens</th>
              <th className="num">Output / M tokens</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(u.prices).map(([m, p]) => (
              <tr key={m}>
                <td>
                  <code>{m}</code>
                </td>
                <td className="num">{fmtUsd(p.input, 2)}</td>
                <td className="num">{fmtUsd(p.output, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {u.unpriced > 0 && <p className="muted small">{u.unpriced} calls used a model with no known price and are counted as $0.</p>}
      </section>
    </div>
  );
}

function DailyBars({ days }: { days: UsageSummary['days'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...days.map((d) => d.cost), 0.01);
  // A gentle ceiling so one expensive day doesn't flatten the rest into nothing.
  const nice = niceMax(max);
  const H = 140;
  return (
    <div className="bars-wrap">
      <div className="bars-axis">
        <span>{fmtUsd(nice, nice < 1 ? 2 : 0)}</span>
        <span>{fmtUsd(nice / 2, nice < 1 ? 2 : 1)}</span>
        <span>$0</span>
      </div>
      <div className="bars" style={{ height: H }} onMouseLeave={() => setHover(null)}>
        <div className="bars-grid" />
        {days.map((d, i) => {
          const h = d.cost > 0 ? Math.max(3, (d.cost / nice) * H) : 0;
          return (
            <div key={d.day} className={cx('bar-slot', hover === i && 'hover')} onMouseEnter={() => setHover(i)}>
              <div className="bar" style={{ height: h }} />
              {hover === i && (
                <div className={cx('bar-tip', i > 22 && 'left')}>
                  <strong>{fmtDate(d.day)}</strong>
                  <span>
                    {fmtUsd(d.cost)} · {d.calls} call{d.calls === 1 ? '' : 's'}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="bars-x">
        <span>{fmtDate(days[0].day)}</span>
        <span>today</span>
      </div>
    </div>
  );
}

function niceMax(v: number) {
  const steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  return steps.find((s) => s >= v) || Math.ceil(v / 100) * 100;
}
