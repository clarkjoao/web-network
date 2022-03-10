import { GetServerSideProps } from 'next'
import { getSession } from 'next-auth/react'
import { useTranslation } from 'next-i18next'
import { serverSideTranslations } from 'next-i18next/serverSideTranslations'

import PageHero, { IInfosHero } from '@components/page-hero'
import ListIssues from '@components/list-issues'
import { useState } from 'react'

export default function PageCouncil() {
  const { t } = useTranslation(['common', 'council'])

  const [infos, setInfos] = useState<IInfosHero[]>([
    {
      value: 0,
      label: t('council.ready-bountys')
    },{
      value: 0,
      label: t('council.council-members')
    },{
      value: 0,
      label: t('distributed-developers'),
      currency: 'BEPRO'
    }
  ])
  
  return (
    <div>
      <PageHero title={t('council:title')} subtitle={t('council:subtitle')} infos={infos} />

      <ListIssues filterState="ready" emptyMessage={t('council:empty')} />
    </div>
  )
}

export const getServerSideProps: GetServerSideProps = async ({ locale }) => {
  return {
    props: {
      session: await getSession(),
      ...(await serverSideTranslations(locale, ['common', 'bounty', 'council']))
    }
  }
}
