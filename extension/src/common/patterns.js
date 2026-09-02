/**
 * Heuristics shared by the field detector and the SMS parser.
 * Everything here is deliberately data-only so the options page can show and
 * override it without importing DOM code.
 */

/** Words that appear next to a one-time code in an SMS, zh + en. */
export const CODE_KEYWORDS = [
  '验证码', '校验码', '动态码', '动态密码', '短信码', '确认码', '安全码', '验证代码',
  '登录码', '识别码', '口令', '验证',
  'verification code', 'verify code', 'security code', 'one-time', 'one time',
  'passcode', 'otp', 'code', 'pin', 'auth',
];

/** Tokens right after a number that mean "this number is NOT the code". */
export const NEGATIVE_SUFFIXES = [
  '分钟', '分鐘', '小时', '小時', '秒', '天', '元', '折', '%', '％',
  'minutes', 'minute', 'mins', 'min', 'hours', 'hour', 'seconds', 'days',
];

/** Tokens right before a number that mean "this number is NOT the code". */
export const NEGATIVE_PREFIXES = [
  '订单', '訂單', '单号', '單號', '金额', '金額', '余额', '餘額', '尾号', '尾號',
  '工号', '会员', '卡号', '快递', '运单', '手机号', '电话',
  'order', 'invoice', 'amount', 'balance', 'ticket', 'tracking', 'ref',
];

/**
 * Field naming is split into three buckets because `verifyCode` is genuinely
 * ambiguous in the wild: on Chinese sites it is an image CAPTCHA about as often
 * as it is an SMS code. Only the unambiguous tokens carry a decisive weight; the
 * ambiguous ones are resolved by looking for an adjacent image or a "send code"
 * button.
 */

/** Unambiguously an SMS / one-time code field. */
export const OTP_STRONG_RE =
  /(one[-_ ]?time[-_ ]?(code|password|pwd)|\botp\b|sms[-_ ]?(code|captcha|verify)|smscode|msg[-_ ]?code|mobile[-_ ]?code|phone[-_ ]?code|dynamic[-_ ]?(code|pwd|password)|短信验证码|手机验证码|短信码|动态码|动态密码|手机验证)/i;

/** Unambiguously an image CAPTCHA field. */
export const CAPTCHA_STRONG_RE =
  /(captcha|kaptcha|img[-_ ]?code|image[-_ ]?code|pic[-_ ]?code|sec[-_ ]?code|security[-_ ]?code|rand(om)?[-_ ]?code|图形验证码|图片验证码|图形码|图片码|验证图|看不清)/i;

/** Could be either; needs corroborating evidence from the surrounding DOM. */
export const CODE_AMBIGUOUS_RE =
  /(verif(y|ication)?[-_ ]?code|auth[-_ ]?code|valid(ate)?[-_ ]?code|check[-_ ]?code|\bvcode\b|\byzm\b|yanzhengma|验证码|校验码|验证)/i;

/** Weak signal: field is *some* kind of code field. Needs corroboration. */
export const GENERIC_CODE_ATTR_RE = /(^|[^a-z])code([^a-z]|$)|验证|verify|verification/i;

/** Text on the button that requests an SMS code. */
export const SEND_CODE_BUTTON_RE =
  /(获取验证码|发送验证码|获取短信|发送短信|重新获取|重新发送|重发|获取动态码|点击获取|send\s*(the\s*)?code|get\s*code|resend|request\s*code|verify\s*by\s*sms)/i;

/** Text on the button that submits the form we just filled. */
export const SUBMIT_BUTTON_RE =
  /(登录|登陆|登入|提交|确定|确认|下一步|注册|验证|continue|submit|sign\s*in|log\s*in|next|verify|confirm)/i;

/** Elements that must never be auto-filled even if they look like code fields. */
export const FIELD_BLOCK_RE = /(password|passwd|pwd|密码|口令密码|card|cvv|cvc|bank|身份证|idcard)/i;

/** Anchors whose alt/title/class marks them as the CAPTCHA image. */
export const CAPTCHA_IMG_RE =
  /(captcha|kaptcha|verif|vcode|yzm|checkcode|seccode|randcode|validate|验证码|验证图|图形码)/i;

/** Typical rendered size of a CAPTCHA image, used to score candidates. */
export const CAPTCHA_IMG_SIZE = {
  minWidth: 34,
  maxWidth: 320,
  minHeight: 14,
  maxHeight: 120,
  idealRatioMin: 1.5,
  idealRatioMax: 6.5,
};

export const CHARSETS = {
  digits: '0123456789',
  alpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  alnum: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  upperAlnum: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
};
