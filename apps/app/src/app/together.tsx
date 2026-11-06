import { WelcomeGate } from '../ui/WelcomeGate'
import { Redirect } from 'expo-router'

export default function Together() { return <WelcomeGate><Redirect href="/chat-search?scope=work" /></WelcomeGate> }
