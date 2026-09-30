import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { Placeholder } from '../ui/Placeholder'

export default function Settings() {
  return <Placeholder title={t(useLang(), 'settings.title')} />
}
