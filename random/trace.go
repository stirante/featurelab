package random

// Method is the draw-method code used by the golden digest's fixed 13-byte
// draw record: uint8 methodCode, int32LE bound, float64LE value.
type Method uint8

const (
	MethodNextInt Method = iota
	MethodNextIntBound
	MethodNextFloat
	MethodNextDouble
	MethodNextBoolean
	MethodNextUnsignedInt
)

// DrawRecord is one recorded RNG draw, in the shape the golden digest's
// draw-hash encoding expects.
type DrawRecord struct {
	Method Method
	Bound  int32
	Value  float64
}

// Tracer wraps an IRandom, recording every draw actually made (in call
// order) without changing any returned value — this is what the golden-dump
// generator records placements through, including the
// NextIntBound(0) non-draw exclusion (matches the engine's bounded integer
// draw and its real "bound 0 returns 0 without drawing" contract).
type Tracer struct {
	inner IRandom
	Draws []DrawRecord
}

// NewTracer wraps inner for draw recording.
func NewTracer(inner IRandom) *Tracer {
	return &Tracer{inner: inner}
}

func (t *Tracer) NextInt() int32 {
	v := t.inner.NextInt()
	t.Draws = append(t.Draws, DrawRecord{Method: MethodNextInt, Bound: 0, Value: float64(v)})
	return v
}

func (t *Tracer) NextIntBound(bound int) int {
	v := t.inner.NextIntBound(bound)
	if bound != 0 {
		t.Draws = append(t.Draws, DrawRecord{Method: MethodNextIntBound, Bound: int32(bound), Value: float64(v)})
	}
	return v
}

func (t *Tracer) NextFloat() float64 {
	v := t.inner.NextFloat()
	t.Draws = append(t.Draws, DrawRecord{Method: MethodNextFloat, Bound: 0, Value: v})
	return v
}

func (t *Tracer) NextDouble() float64 {
	v := t.inner.NextDouble()
	t.Draws = append(t.Draws, DrawRecord{Method: MethodNextDouble, Bound: 0, Value: v})
	return v
}

func (t *Tracer) NextBoolean() bool {
	v := t.inner.NextBoolean()
	value := 0.0
	if v {
		value = 1.0
	}
	t.Draws = append(t.Draws, DrawRecord{Method: MethodNextBoolean, Bound: 0, Value: value})
	return v
}

func (t *Tracer) NextUnsignedInt(bound uint32) uint32 {
	v := t.inner.NextUnsignedInt(bound)
	if bound != 0 {
		t.Draws = append(t.Draws, DrawRecord{Method: MethodNextUnsignedInt, Bound: int32(bound), Value: float64(v)})
	}
	return v
}

// SetSeed forwards to inner without recording -- reseeding is not itself a
// draw (produces no output value), matching the golden digest's draw-hash
// encoding, which only ever records actual outputs.
func (t *Tracer) SetSeed(seed uint32) { t.inner.SetSeed(seed) }

// GetSeed forwards to inner without recording, for the same reason as
// SetSeed.
func (t *Tracer) GetSeed() uint32 { return t.inner.GetSeed() }

var _ IRandom = (*Tracer)(nil)
