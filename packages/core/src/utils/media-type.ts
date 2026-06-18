import path from 'node:path'

/** 把文件扩展名映射为 IANA 媒体类型。
 *  这个值主要作为 `ImagePart.mediaType` 的提示信息使用；
 *  遇到未知扩展名时回退到 `image/png` 也是安全的，因为 SDK
 *  大多把 `mediaType` 当作辅助提示而不是强校验。 */
export function mediaTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  // 未知图片扩展名统一按 PNG 提示，避免缺少 mediaType。
  return 'image/png'
}
