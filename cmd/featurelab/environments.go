package main

import "github.com/stirante/featurelab/wire"

// The `environments` response shape lives in wire (see wire/environments.go), shared with the
// browser playground. The names stay here as aliases because this is where the desktop app's
// own EnvironmentOption points a reader for the other half of its "change both" rule.
type (
	EnvironmentDefaultsOutput  = wire.EnvironmentDefaultsOutput
	EnvironmentMaterialsOutput = wire.EnvironmentMaterialsOutput
	EnvironmentOption          = wire.EnvironmentOption
)

// environmentsOutput is serve's "environments" method: every env.ENVIRONMENTS preset, in order.
func environmentsOutput() []EnvironmentOption { return wire.Environments() }
