package jigsaw

import "testing"

// Expected values are what java.util.Random returns on a JVM.
func TestJavaRandomMatchesJava(t *testing.T) {
	r := newJavaRandom(42)
	if got := int32(r.next(32)); got != -1170105035 {
		t.Errorf("Random(42).nextInt() = %d, want -1170105035", got)
	}
	if got := int32(r.next(32)); got != 234785527 {
		t.Errorf("second nextInt() = %d, want 234785527", got)
	}
	r = newJavaRandom(42)
	if got := r.nextInt(100); got != 30 {
		t.Errorf("Random(42).nextInt(100) = %d, want 30", got)
	}
	if got := r.nextInt(100); got != 63 {
		t.Errorf("second nextInt(100) = %d, want 63", got)
	}
	r = newJavaRandom(0)
	if got := r.nextLong(); got != -4962768465676381896 {
		t.Errorf("Random(0).nextLong() = %d", got)
	}
	r = newJavaRandom(0)
	if got := r.nextFloat(); got != 0.73096776 {
		t.Errorf("Random(0).nextFloat() = %v", got)
	}
}

func TestJavaRandomNextIntPowerOfTwoUsesHighBits(t *testing.T) {
	r := newJavaRandom(0)
	raw := newJavaRandom(0)
	want := int((int64(16) * int64(raw.next(31))) >> 31)
	if got := r.nextInt(16); got != want {
		t.Errorf("nextInt(16) = %d, want %d", got, want)
	}
}

func TestLargeFeatureSeedDependsOnChunk(t *testing.T) {
	first, second := newJavaRandom(0), newJavaRandom(0)
	first.setLargeFeatureSeed(1234, 3, 4)
	second.setLargeFeatureSeed(1234, 3, 5)
	if first.nextLong() == second.nextLong() {
		t.Error("two chunks of one world seed drew the same value")
	}
	again := newJavaRandom(0)
	again.setLargeFeatureSeed(1234, 3, 4)
	replay := newJavaRandom(0)
	replay.setLargeFeatureSeed(1234, 3, 4)
	if again.nextInt(1000) != replay.nextInt(1000) {
		t.Error("the same chunk and seed did not replay")
	}
}
