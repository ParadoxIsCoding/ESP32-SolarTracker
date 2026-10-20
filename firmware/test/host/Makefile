SRC := ../../OpenInverterGateway/SRC/ShineWiFi-ModBus
CXXFLAGS := -std=c++17 -Wall -Wextra -Werror -O1 -I$(SRC)

test: test_core
	./test_core

test_core: test_core.cpp $(SRC)/SolarCore.cpp $(SRC)/SolarCore.h $(SRC)/Catalog.gen.h
	$(CXX) $(CXXFLAGS) -o $@ test_core.cpp $(SRC)/SolarCore.cpp

clean:
	rm -f test_core
.PHONY: test clean
