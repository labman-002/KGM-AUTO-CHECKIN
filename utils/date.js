/**
 * 北京时间（UTC+8）日期工具。
 *
 * 背景：原实现假定运行环境为 UTC（GitHub Actions runner），
 * 通过 new Date() 加 8 小时偏移得到北京时间。
 * Docker / 本地部署时容器时区不可控（可能是 UTC、Asia/Shanghai 或其他），
 * 固定偏移会导致日期重复偏移或偏移不足。
 *
 * 这里改用 Intl 按固定时区 Asia/Shanghai 换算，与宿主/容器时区无关，
 * 在 GitHub Actions、Docker、本地开发等任意环境下结果一致。
 */

const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
})

/**
 * 获取当前（或指定时刻）的北京时间日期字符串，格式 YYYY-MM-DD
 * @param {Date} [d=new Date()]
 * @returns {string}
 */
function beijingDateStr(d = new Date()) {
  // en-CA 的数字日期格式恰好是 YYYY-MM-DD
  return DATE_FORMATTER.format(d)
}

/**
 * 判断当前（或指定时刻）的北京时间是否为周日（token 每周日刷新）
 * @param {Date} [d=new Date()]
 * @returns {boolean}
 */
function isBeijingSunday(d = new Date()) {
  return WEEKDAY_FORMATTER.format(d) === 'Sun'
}

export { beijingDateStr, isBeijingSunday }
