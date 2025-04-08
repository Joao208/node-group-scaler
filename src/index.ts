import * as k8s from '@kubernetes/client-node'
import { NodeGroupScalerController, nodeGroupScalerCRD } from './utils'

async function main() {
  const kc = new k8s.KubeConfig()
  kc.loadFromDefault()

  const k8sApi = kc.makeApiClient(k8s.ApiextensionsV1Api)

  try {
    console.log('Registering NodeGroupScalingPolicy CRD...')

    await k8sApi.createCustomResourceDefinition({
      body: nodeGroupScalerCRD,
    })

    console.log('CRD registered successfully!')

    const controller = new NodeGroupScalerController(kc)
    await controller.start()
  } catch (error: any) {
    if (error.response?.statusCode === 409) {
      console.log('CRD already exists, continuing...')
      const controller = new NodeGroupScalerController(kc)
      await controller.start()
    } else {
      console.error('Error initializing controller:', error)
      process.exit(1)
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
