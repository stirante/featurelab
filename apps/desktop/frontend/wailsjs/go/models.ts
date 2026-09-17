export namespace main {
	
	export class EnvironmentOption {
	    id: string;
	    label: string;
	    description: string;
	    defaultSizeX: number;
	    defaultSizeY: number;
	    defaultSizeZ: number;
	    defaultMinY: number;
	    buildsSea: boolean;
	
	    static createFrom(source: any = {}) {
	        return new EnvironmentOption(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.description = source["description"];
	        this.defaultSizeX = source["defaultSizeX"];
	        this.defaultSizeY = source["defaultSizeY"];
	        this.defaultSizeZ = source["defaultSizeZ"];
	        this.defaultMinY = source["defaultMinY"];
	        this.buildsSea = source["buildsSea"];
	    }
	}
	export class PackItem {
	    kind: string;
	    identifier: string;
	    typeId: string;
	    fileId: string;
	
	    static createFrom(source: any = {}) {
	        return new PackItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.identifier = source["identifier"];
	        this.typeId = source["typeId"];
	        this.fileId = source["fileId"];
	    }
	}
	export class LoadPackResult {
	    dir: string;
	    warnings: string[];
	    items: PackItem[];
	
	    static createFrom(source: any = {}) {
	        return new LoadPackResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.dir = source["dir"];
	        this.warnings = source["warnings"];
	        this.items = this.convertValues(source["items"], PackItem);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace wire {
	
	export class Materials {
	    topMaterial?: string;
	    midMaterial?: string;
	    foundationMaterial?: string;
	    seaFloorMaterial?: string;
	    seaMaterial?: string;
	    seaFloorDepth?: number;
	
	    static createFrom(source: any = {}) {
	        return new Materials(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.topMaterial = source["topMaterial"];
	        this.midMaterial = source["midMaterial"];
	        this.foundationMaterial = source["foundationMaterial"];
	        this.seaFloorMaterial = source["seaFloorMaterial"];
	        this.seaMaterial = source["seaMaterial"];
	        this.seaFloorDepth = source["seaFloorDepth"];
	    }
	}
	export class GenerateParams {
	    feature?: string;
	    rule?: string;
	    env?: string;
	    seed?: number;
	    origin?: string;
	    size?: string;
	    minY?: number;
	    biomeId?: string;
	    biomeTags?: string[];
	    materials?: Materials;
	    repeat?: number;
	    profile?: boolean;
	    writeBudget?: number;
	    delegationBudget?: number;
	    placementTimeLimitMs?: number;
	
	    static createFrom(source: any = {}) {
	        return new GenerateParams(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.feature = source["feature"];
	        this.rule = source["rule"];
	        this.env = source["env"];
	        this.seed = source["seed"];
	        this.origin = source["origin"];
	        this.size = source["size"];
	        this.minY = source["minY"];
	        this.biomeId = source["biomeId"];
	        this.biomeTags = source["biomeTags"];
	        this.materials = this.convertValues(source["materials"], Materials);
	        this.repeat = source["repeat"];
	        this.profile = source["profile"];
	        this.writeBudget = source["writeBudget"];
	        this.delegationBudget = source["delegationBudget"];
	        this.placementTimeLimitMs = source["placementTimeLimitMs"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

