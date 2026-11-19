// 插件托管 SOCKS5 的首选端口。已保存的旧端口不迁移。
export const DEFAULT_IWAN_SOCKS_PORT = 21080

/** 需求给定的 11 段 USTC 网段与默认域名后缀。 */
export const DEFAULT_CIDRS = [
  '114.214.160.0/19',
  '114.214.192.0/18',
  '202.38.64.0/19',
  '210.45.64.0/20',
  '210.45.112.0/20',
  '211.86.144.0/20',
  '222.195.64.0/19',
  '210.72.22.0/24',
  '202.141.160.0/19',
  '218.22.21.0/27',
  '218.104.71.160/28',
].join(',')

export const DEFAULT_SUFFIXES = 'ustc.edu.cn,ustclug.org,ustc.life'
