/*
	dspsim-known: the answers of the emulator's DSP core to its own known-answer programs, for the playground's
	module to be held to (src/lib/aicaDspModule.test.ts).

	npm run build:dspsim compiles this with the emulator tree it builds the module from, together with that tree's
	libswirl/hw/aica/dsp_core/aica_dsp_core.cpp and tests/aica_dsp/dsp_known.cpp, runs it once and deletes it: it is
	compiled when the module is regenerated, never by the build or by the tests.

	    dspsim-known <out.json>

	The known-answer programs (dsp_known.cpp: the shifter, the address of a memory step, the ring, the read latch,
	the MIXS banks) are written on KnownMachine, which is nothing but the calls a user of the core has. Here that
	machine is the core called itself, natively, and every call goes into a trace with the core's answer: what the
	CPU reads, a register by its index, a word of the wave RAM, how many bytes of it are not 0, a digest of the views
	of the single steps, and at every known answer a digest of the state and of the arrays the playground shows. The
	test makes the same calls on aica_dsp_core.wasm through its loader and has to get the same answers.

	A known answer that the native core does not give is a defect of the tree, not of the module: nothing is written
	and the exit status is 1.

	The output has numbers and the names of the groups of dsp_known.cpp in it, nothing of the machine that ran it.
*/
#include "hw/aica/dsp_core/aica_dsp_core.h"
#include "hw/aica/dsp_core/wasm/aica_dsp_capi.h"
#include "dsp_known.h"

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

//The operations of the trace: each its number, its arguments, then the answers it expects. The test has the same list
enum
{
	K_CREATE = 1,			//size: a core after power on with a wave RAM of that size, all 0, and its inputs off
	K_RESET = 2,
	K_REG_WRITE = 3,		//off, value
	K_REG_READ = 4,			//off; expects: what the CPU reads
	K_SET = 5,				//index, value
	K_GET = 6,				//index; expects: the value, as 32 bit
	K_RAM_WRITE = 7,		//byte address, word: 16 bit, little endian
	K_RAM_READ = 8,			//byte address; expects: the word
	K_RAM_USED = 9,			//expects: the number of bytes of the wave RAM that are not 0
	K_INPUTS = 10,			//on, sent, fetch low, fetch high, 16 sums, 64 words
	K_STEPS = 11,			//count; expects: the digest of the views of those steps
	K_RUN_SAMPLE = 12,
	K_SWEEP_BEGIN = 13,
	K_MIXS_SEND = 14,		//bus, value
	K_MIXS_SEND_LATE = 15,	//bus, value
	K_CHANNEL_FETCH = 16,	//word
	K_BUS_READ = 17,		//word
	K_GROUP = 18,			//the index of its name in "groups"
	K_CHECK = 19,			//expects: the digests of the state, of TEMP, MEMS, MIXS (both banks), EFREG, COEF, MADRS, MPRO
	K_END = 20,
};

#define FNV_START 2166136261u

static uint32_t fnv(uint32_t hash, const uint8_t* data, size_t size)
{
	for (size_t i = 0; i < size; i++)
		hash = (hash ^ data[i]) * 16777619u;

	return hash;
}

//An array as the numbers it holds: of every element its value in 32 bit, little endian, and whether it is negative
template <typename T> static uint32_t numbers(uint32_t hash, const T* data, size_t count)
{
	for (size_t i = 0; i < count; i++)
	{
		const int64_t value = data[i];
		const uint32_t low = (uint32_t)value;
		const uint8_t bytes[5] = { (uint8_t)low, (uint8_t)(low >> 8), (uint8_t)(low >> 16), (uint8_t)(low >> 24), (uint8_t)(value < 0) };

		hash = fnv(hash, bytes, sizeof(bytes));
	}

	return hash;
}

static std::vector<uint32_t> trace;
static std::vector<std::string> groups;

static void put(uint32_t word) { trace.push_back(word); }

struct TraceMachine : KnownMachine
{
	AicaDsp dsp;
	std::vector<uint8_t> ram;
	AicaDspSampleInputs inputs;
	bool inputs_on = false;
	uint32_t known = 0, failed = 0;
	std::string group;

	const AicaDspSampleInputs* Given() const { return inputs_on ? &inputs : nullptr; }

	void Create(uint32_t ram_size) override
	{
		put(K_CREATE); put(ram_size);
		ram.assign(ram_size, 0);
		dsp.Init(ram.data(), ram_size);
		memset(&inputs, 0, sizeof(inputs));
		inputs_on = false;
	}

	void Reset() override { put(K_RESET); dsp.Reset(); }

	void RegWrite(uint32_t off, uint32_t value) override
	{
		put(K_REG_WRITE); put(off); put(value);
		dsp.RegWrite(off, value);
	}

	uint32_t RegRead(uint32_t off) override
	{
		const uint32_t value = dsp.RegRead(off);

		put(K_REG_READ); put(off); put(value);

		return value;
	}

	void Set(uint32_t index, uint32_t value) override
	{
		put(K_SET); put(index); put(value);
		dsp_known_set(dsp, index, value);
	}

	uint32_t Get(uint32_t index) override
	{
		const uint32_t value = dsp_known_get(dsp, index);

		put(K_GET); put(index); put(value);

		return value;
	}

	void RamWrite(uint32_t addr, uint32_t word) override
	{
		put(K_RAM_WRITE); put(addr); put(word);
		ram[addr] = (uint8_t)word;
		ram[addr + 1] = (uint8_t)(word >> 8);
	}

	uint32_t RamRead(uint32_t addr) override
	{
		const uint32_t word = (uint32_t)(ram[addr] | (ram[addr + 1] << 8));

		put(K_RAM_READ); put(addr); put(word);

		return word;
	}

	uint32_t RamUsed() override
	{
		uint32_t used = 0;

		for (uint8_t byte : ram)
			used += byte != 0;

		put(K_RAM_USED); put(used);

		return used;
	}

	void Inputs(const AicaDspSampleInputs* in) override
	{
		static const AicaDspSampleInputs none = {};
		const AicaDspSampleInputs& given = in ? *in : none;

		inputs_on = in != nullptr;
		inputs = given;

		put(K_INPUTS); put(inputs_on); put(given.mixs_sent);
		put((uint32_t)given.fetch); put((uint32_t)(given.fetch >> 32));

		for (int i = 0; i < 16; i++)
			put((uint32_t)given.mixs[i]);

		for (int k = 0; k < 64; k++)
			put(given.fetch_word[k]);
	}

	void Steps(uint32_t count) override
	{
		uint32_t views = FNV_START;

		for (uint32_t i = 0; i < count; i++)
		{
			AicaDspStepView view;

			dsp.StepOne(Given(), &view);
			views = fnv(views, (const uint8_t*)&view, sizeof(view));
		}

		put(K_STEPS); put(count); put(views);
	}

	void RunSample() override { put(K_RUN_SAMPLE); dsp.RunSample(Given()); }
	void SweepBegin() override { put(K_SWEEP_BEGIN); dsp.SweepBegin(); }

	void MixsSend(uint32_t bus, int32_t value) override
	{
		put(K_MIXS_SEND); put(bus); put((uint32_t)value);
		dsp.MixsSend(bus, value);
	}

	void MixsSendLate(uint32_t bus, int32_t value) override
	{
		put(K_MIXS_SEND_LATE); put(bus); put((uint32_t)value);
		dsp.MixsSendLate(bus, value);
	}

	void ChannelFetch(uint32_t word) override
	{
		put(K_CHANNEL_FETCH); put(word);
		dsp.ChannelFetch((uint16_t)word);
	}

	void BusRead(uint32_t word) override
	{
		put(K_BUS_READ); put(word);
		dsp.BusRead((uint16_t)word);
	}

	void Group(const char* name) override
	{
		size_t index = 0;

		while (index < groups.size() && groups[index] != name)
			index++;

		if (index == groups.size())
			groups.push_back(name);

		group = name;
		put(K_GROUP); put((uint32_t)index);
	}

	void Check(bool holds, const char* what) override
	{
		known++;

		if (!holds && failed++ < 10)
			fprintf(stderr, "dspsim-known: %s, %s: the native core does not give the known answer\n", group.c_str(), what);

		std::vector<uint8_t> blob(AicaDsp::StateSize());

		dsp.SaveState(blob.data());

		put(K_CHECK);
		put(fnv(FNV_START, blob.data(), blob.size()));
		put(numbers(FNV_START, dsp.TEMP, 128));
		put(numbers(FNV_START, dsp.MEMS, 32));
		put(numbers(numbers(FNV_START, dsp.MIXS[0], 16), dsp.MIXS[1], 16));
		put(numbers(FNV_START, dsp.EFREG, 16));
		put(numbers(FNV_START, dsp.COEF, 128));
		put(numbers(FNV_START, dsp.MADRS, 64));
		put(numbers(FNV_START, &dsp.MPRO[0][0], 128 * 4));
	}
};

int main(int argc, char** argv)
{
	if (argc != 2)
	{
		fprintf(stderr, "dspsim-known <out.json>\n");
		return 2;
	}

	static TraceMachine machine;

	dsp_known_answers(machine);
	put(K_END);

	if (machine.failed)
	{
		fprintf(stderr, "dspsim-known: %u of %u known answers are not the native core's, nothing written\n", machine.failed, machine.known);
		return 1;
	}

	FILE* f = fopen(argv[1], "wb");

	if (!f)
	{
		fprintf(stderr, "dspsim-known: cannot write the output\n");
		return 2;
	}

	fprintf(f, "{\"apiVersion\":%u,\"known\":%u,\"groups\":[", AICA_DSP_API_VERSION, machine.known);

	for (size_t i = 0; i < groups.size(); i++)
		fprintf(f, "%s\"%s\"", i ? "," : "", groups[i].c_str());

	fprintf(f, "],\"trace\":[");

	for (size_t i = 0; i < trace.size(); i++)
		fprintf(f, "%s%u", i ? "," : "", trace[i]);

	fprintf(f, "]}\n");
	fclose(f);

	printf("dspsim-known: %u known answers in %zu groups, %zu words of trace\n", machine.known, groups.size(), trace.size());

	return 0;
}
