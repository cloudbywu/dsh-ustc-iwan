/** PKCE sign-in and encrypted line provisioning compatible with the upstream public client. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { saveNodeIwanCredentials } from '../credentials.js'

const AUTHORIZE = 'https://auth.ivpn.ustc.edu.cn/login/oauth/authorize'
const TOKEN_URL = 'https://auth.ivpn.ustc.edu.cn/api/login/oauth/access_token'
const CONTROLLER = 'https://crtl.ivpn.ustc.edu.cn'
const CLIENT = 'afc6479ffb531d71daef'
const CALLBACK = 'com.panabit.mobile://oauth2redirect'
const DOMAIN = 'iwan.ustc'
const APP_ID = 'controller-ustc'
// Fixed public-client protocol parameter published in upstream controller.rs; this is not a user credential.
const APP_SIGNING_MATERIAL = "ca6a3532abd2986a03b86b3a"
const digest = value => createHash('sha256').update(value)

async function postJson(url, { body, headers, signal }) {
  let response
  try { response = await fetch(url, { method:'POST', body, headers, signal, redirect:'error' }) }
  catch { signal?.throwIfAborted(); throw new Error('无法连接学校 iWAN 认证服务') }
  if (response.status !== 200) {
    await response.body?.cancel()
    throw new Error('学校 iWAN 认证服务返回 HTTP ' + response.status)
  }
  const chunks = []
  let size = 0
  try {
    for await (const chunk of response.body ?? []) {
      if ((size += chunk.byteLength) > 1024 * 1024) throw new Error('size')
      chunks.push(chunk)
    }
    return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks)))
  } catch {
    signal?.throwIfAborted()
    throw new Error('学校 iWAN 认证服务返回了无效或过大的响应')
  }
}

function usernameFromToken(value) {
  try {
    const raw = value.split('.')[1]
    if (!raw || raw.length > 16384 || !/^[a-z0-9_-]+$/i.test(raw)) throw new Error()
    const claims = JSON.parse(Buffer.from(raw,'base64url').toString('utf8'))
    // Identifier only. The controller, not this unverified display claim, verifies the access token.
    return [claims.name, claims.preferred_username, claims.sub].find(name =>
      typeof name === 'string' && name.length > 0 && name.length <= 256 && !/[\u0000-\u001f]/.test(name)) ?? 'unknown'
  } catch { return 'unknown' }
}

const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b))

export function createNodeIwanAuthorization({ configDir, post = postJson, save = saveNodeIwanCredentials, now = Date.now } = {}) {
  let verifier = randomBytes(64).toString('base64url'), state = randomBytes(24).toString('base64url')
  const url = new URL(AUTHORIZE)
  url.search = new URLSearchParams({ client_id: CLIENT, redirect_uri: CALLBACK, response_type:'code',
    scope:'openid profile email offline_access', code_challenge:digest(verifier).digest('base64url'), code_challenge_method:'S256', state })
  const clear = () => { verifier = state = '' }
  function prepare(redirect) {
    if (!state) throw new Error('认证会话已结束')
    let parsed
    try { parsed = new URL(redirect) } catch { throw new Error('认证回调 URL 无效') }
    if (parsed.protocol !== 'com.panabit.mobile:' || parsed.host !== 'oauth2redirect' || parsed.pathname !== '' ||
        parsed.username || parsed.password || parsed.hash || parsed.searchParams.has('error')) throw new Error('不是本次学校 iWAN 登录回调')
    const codes = parsed.searchParams.getAll('code'), states = parsed.searchParams.getAll('state')
    if (states.length !== 1 || !equal(states[0], state)) throw new Error('认证回调与当前会话不匹配，请使用本次打开的登录窗口')
    if (codes.length !== 1 || !codes[0] || codes[0].length > 4096 || /\s/.test(codes[0])) throw new Error('认证回调缺少有效授权码')
    const tokenBody = JSON.stringify({ client_id:CLIENT, code:codes[0], code_verifier:verifier,
      redirect_uri:CALLBACK, grant_type:'authorization_code' })
    clear()
    return async signal => {
      const media = { 'Content-Type':'application/json' }
      const token = await post(TOKEN_URL, { body:tokenBody, headers:media, signal })
      const access = token?.access_token
      if (typeof access !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(access)) throw new Error('学校 iWAN 认证未签发有效登录会话')
      const request = { domain:DOMAIN, type:'android', oem_name:'panabit', device_id:randomBytes(8).toString('hex'),
        userName:usernameFromToken(token.id_token), serverlist_version:'0', ipfilter_version:'0', branding_version:'0' }
      async function signed(route, payload) {
        signal?.throwIfAborted()
        const body = JSON.stringify(payload)
        const stamp = Math.floor(now() / 1000).toString(), nonce = randomBytes(16).toString('hex').toUpperCase()
        const canonical = ['POST',route,'',digest(body).digest('hex'),stamp,nonce].join('\n')
        const sig = createHmac('sha256', APP_SIGNING_MATERIAL).update(canonical).digest('hex')
        return post(CONTROLLER + route, { body, signal, headers:{ ...media, Authorization:'Bearer '+access,
          'X-Auth-AppId':APP_ID, 'X-Auth-Timestamp':stamp, 'X-Auth-Nonce':nonce, 'X-Auth-Sign':sig } })
      }
      await signed('/m/auth', request)
      await signed('/m/keepalive', { ...request, type:'keepalive' })
      const config = await signed('/m/config', request)
      signal?.throwIfAborted()
      const rows = config?.serverlist?.serverlist
      if (!Array.isArray(rows) || !rows.length || rows.length > 4096) throw new Error('学校 iWAN 服务没有返回可用线路')
      save({ domain:DOMAIN, servers:rows.map(item => ({ name:item?.name ?? '', host:item?.serverName, port:item?.serverPort ?? 6001,
        username:item?.userName, passWord:item?.passWord, salt:item?.salt ?? '', mtu:item?.mtu ?? null })) }, { configDir })
    }
  }
  return { authorizeUrl:url.href, prepare, clear }
}
