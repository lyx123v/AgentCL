import { describe, expect, it } from 'vitest'

import { mediaTypeFor } from '../src/utils/media-type.js'

describe('mediaTypeFor', () => {
  it('会把 .jpg 映射为 image/jpeg', () => {
    expect(mediaTypeFor('photo.jpg')).toBe('image/jpeg')
  })

  it('会把 .jpeg 映射为 image/jpeg', () => {
    expect(mediaTypeFor('photo.jpeg')).toBe('image/jpeg')
  })

  it('会把 .png 映射为 image/png', () => {
    expect(mediaTypeFor('screenshot.png')).toBe('image/png')
  })

  it('会把 .webp 映射为 image/webp', () => {
    expect(mediaTypeFor('hero.webp')).toBe('image/webp')
  })

  it('会把 .gif 映射为 image/gif', () => {
    expect(mediaTypeFor('animation.gif')).toBe('image/gif')
  })

  it('会把 .bmp 映射为 image/bmp', () => {
    expect(mediaTypeFor('bitmap.bmp')).toBe('image/bmp')
  })

  it('未知扩展名默认返回 image/png', () => {
    expect(mediaTypeFor('file.tiff')).toBe('image/png')
    expect(mediaTypeFor('file.svg')).toBe('image/png')
    expect(mediaTypeFor('noext')).toBe('image/png')
  })

  it('可以处理大小写不敏感的扩展名', () => {
    expect(mediaTypeFor('photo.JPG')).toBe('image/jpeg')
    expect(mediaTypeFor('photo.PNG')).toBe('image/png')
    expect(mediaTypeFor('photo.WebP')).toBe('image/webp')
  })
})
