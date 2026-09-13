import { describe, it, expect } from 'vitest'
import { findPictureUrls, fileKey, describePage } from '../chrome-extension/sf-remittance/sf-photos.js'

const KNOWN = ['897f67f0cc4193970f223ea2f778dd87.jpg', '1789066157_9099f0_E6688C4B-1591-4571-81D5-AF38BA3F54D2.jpg']

describe('fileKey', () => {
  it('reduces a URL or name to the shared file name, dropping size suffixes', () => {
    expect(fileKey('https://x.s3.amazonaws.com/a/b/897f67f0cc4193970f223ea2f778dd87.jpg?X-Amz=1')).toBe('897f67f0cc4193970f223ea2f778dd87.jpg')
    expect(fileKey('/uploads/1789066157_9099f0_E6688C4B-1591-4571-81D5-AF38BA3F54D2_thumb.jpg')).toBe('1789066157_9099f0_e6688c4b-1591-4571-81d5-af38ba3f54d2.jpg')
  })
})

describe('findPictureUrls', () => {
  const html = `
    <img src="/img/logo.png"> <img src="https://cdn.sf.com/icons/sprite.png">
    <div class="job-pictures">
      <a href="https://sfcdn.s3.amazonaws.com/company/897f67f0cc4193970f223ea2f778dd87.jpg?X-Amz-Signature=abc"><img src="https://sfcdn.s3.amazonaws.com/company/897f67f0cc4193970f223ea2f778dd87_thumb.jpg"></a>
      <img data-src="/jobs/picture/1789066157_9099f0_E6688C4B-1591-4571-81D5-AF38BA3F54D2.jpg">
      <img src="/uploads/other-photo.jpeg">
    </div>
    <script>var pics = ["/jobs/loadPictures?id=abc", "https://sfcdn.s3.amazonaws.com/company/da3d6c070fac58fe88282518d2f4532b.jpg"];</script>`
  it('flags the URLs that match the API file names, keeps one URL per picture (full size over thumbnail), drops site chrome', () => {
    const r = findPictureUrls(html, KNOWN)
    expect(r.matched.map(x => x.url).sort()).toEqual([
      'https://admin.servicefusion.com/jobs/picture/1789066157_9099f0_E6688C4B-1591-4571-81D5-AF38BA3F54D2.jpg',
      'https://sfcdn.s3.amazonaws.com/company/897f67f0cc4193970f223ea2f778dd87.jpg?X-Amz-Signature=abc',
    ])
    expect(r.others.map(x => x.url).sort()).toEqual(['https://admin.servicefusion.com/uploads/other-photo.jpeg', 'https://sfcdn.s3.amazonaws.com/company/da3d6c070fac58fe88282518d2f4532b.jpg'])
    expect(r.others.some(x => /logo|sprite/.test(x.url))).toBe(false)
  })
  it('reads the gallery block first when the page has one', () => {
    const page = `<img src="/uploads/stray.jpg"><div id="gallery"><ul><li><a href="/files/full-1.jpg"><div><img src="/files/full-1_thumb.jpg"></div></a></li></ul></div></section>`
    const r = findPictureUrls(page, [])
    expect(r.others.map(x => x.url)).toEqual(['https://admin.servicefusion.com/files/full-1.jpg', 'https://admin.servicefusion.com/uploads/stray.jpg'])
  })
  it('works with no known names and no pictures', () => {
    expect(findPictureUrls('<html><img src="/img/logo.png"></html>', [])).toEqual({ matched: [], others: [], knownKeys: [] })
  })
})

describe('describePage', () => {
  it('reports picture-ish script paths and a few snippets', () => {
    const d = describePage(`<script src="/js/app.js"></script><a href="/jobs/loadJobPictures?id=1">Pictures</a> <iframe src="/jobs/photoFrame?id=1"></iframe>`)
    expect(d.paths).toContain('/jobs/loadJobPictures?id=1')
    expect(d.iframes).toEqual(['/jobs/photoFrame?id=1'])
    expect(d.snippets.length).toBeGreaterThan(0)
  })
})
