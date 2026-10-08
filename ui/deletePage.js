/**
 * Remove one page's stored state in an order that cannot leave a listed page
 * whose content is already gone.
 *
 * `artifacts/<id>.json` is the record that makes a page exist, so it is
 * removed first: a failure there leaves the page whole and the owner can
 * simply delete it again. Everything else is content only that record can
 * reach, so a later failure is invisible residue rather than a broken page.
 * Residue also has no second chance once the record is gone, which is why each
 * removal is attempted independently of the others and none of them can fail
 * the deletion.
 */
export async function removePageStorage(storage, artifactId) {
  await storage.removeConfirmed(`artifacts/${artifactId}.json`)
  await Promise.allSettled([
    storage.removeFolder(`versions/${artifactId}`),
    storage.removeFolder(`projects/${artifactId}`),
    storage.removeFolder(`artifact-data/${artifactId}`),
    storage.remove(`shares/${artifactId}.json`),
  ])
}
