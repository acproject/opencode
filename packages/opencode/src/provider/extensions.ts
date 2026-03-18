export namespace ProviderExtensions {
  export type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>
  export type CustomLoader = (provider: any) => Promise<{
    autoload: boolean
    getModel?: CustomModelLoader
    options?: Record<string, any>
  }>

  const loaders: Record<string, CustomLoader> = {}

  export function registerCustomLoader(id: string, loader: CustomLoader) {
    loaders[id] = loader
  }

  export function customLoaders() {
    return { ...loaders }
  }
}

