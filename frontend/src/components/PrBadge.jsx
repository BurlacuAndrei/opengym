import Icon from './Icon.jsx'
import { PR_RANKS, getRankMeta } from '../lib/pr.js'

/**
 * PR trophy badge component for cardio activity summaries and personal records (Issue #66).
 * Renders Rank 1 = Gold PR, Rank 2 = Silver, Rank 3 = Bronze.
 *
 * @param {Object} props
 * @param {number} [props.rank=1] - Rank number (1: Gold, 2: Silver, 3: Bronze)
 * @param {string} [props.label] - Custom label text (e.g. 'PR', '5k PR', '1k')
 * @param {boolean} [props.showIcon=true] - Whether to show the trophy icon
 * @param {string} [props.icon='trophy'] - Icon name to render
 * @param {string} [props.size='sm'] - Size variant ('sm', 'md')
 * @param {string} [props.className=''] - Extra CSS classes
 * @param {Object} [props.style={}] - Inline style overrides
 * @param {string} [props.title] - Hover tooltip
 */
export default function PrBadge({
  rank = 1,
  label,
  showIcon = true,
  icon = 'trophy',
  size = 'sm',
  className = '',
  style = {},
  title,
}) {
  const meta = getRankMeta(rank) || PR_RANKS[1]
  const displayLabel = label ?? meta.label
  const tooltip = title ?? meta.title

  const rankStyle = {
    color: meta.color,
    background: meta.bg,
    ...(size === 'md' ? { padding: '4px 10px', fontSize: '13px' } : {}),
    ...style,
  }

  return (
    <span
      className={`pr pr-${meta.name} ${className}`.trim()}
      style={rankStyle}
      title={tooltip}
      aria-label={`${meta.title}: ${displayLabel}`}
    >
      {showIcon && <Icon name={icon} />}
      <span>{displayLabel}</span>
    </span>
  )
}

/**
 * Renders badges for an array of PR achievements on an activity summary.
 *
 * @param {Object} props
 * @param {Array} [props.prs] - Array of PR items from detectActivityPRs or activity.prs
 * @param {number} [props.max=3] - Maximum number of badges to display
 * @param {string} [props.className=''] - Extra CSS classes
 */
export function ActivityPrBadges({ prs = [], max = 3, className = '' }) {
  if (!Array.isArray(prs) || prs.length === 0) return null

  const displayList = prs.slice(0, max)
  const remaining = prs.length - displayList.length

  return (
    <div
      className={`activity-pr-badges ${className}`.trim()}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}
    >
      {displayList.map((pr, idx) => {
        const text = pr.label ? `${pr.label} ${pr.rank === 1 ? 'PR' : pr.rankLabel || `${pr.rank}nd`}` : pr.rankLabel || 'PR'
        return (
          <PrBadge
            key={pr.label || idx}
            rank={pr.rank}
            label={text}
          />
        )
      })}
      {remaining > 0 && (
        <span className="dim small" style={{ fontSize: 11, marginLeft: 2 }}>
          +{remaining}
        </span>
      )}
    </div>
  )
}
