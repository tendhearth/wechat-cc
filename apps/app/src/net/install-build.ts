import Constants from 'expo-constants'
import { appBuild } from './build'

appBuild.value = Constants.nativeBuildVersion ?? undefined
