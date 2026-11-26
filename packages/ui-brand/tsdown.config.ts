import { pluginBuilds } from '../../scripts/plugin-build.ts'

export default pluginBuilds(import.meta.dirname, { client: true })
