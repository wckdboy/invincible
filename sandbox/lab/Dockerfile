# The Lab: where Galahad does mathematics, physics and engineering. Same rules as
# the workshop image (../Dockerfile): unprivileged uid 1000, read-only at runtime,
# no capabilities. Heavy compiled stacks come from Debian (consistent ABIs); the
# rest from pinned wheels in /opt/lab, a venv that can't replace Debian's numpy.
FROM debian:trixie-slim

# Slim images drop /usr/share/doc; OpenFOAM's tutorials live there, and they're cases to run, not docs.
RUN echo 'path-include=/usr/share/doc/openfoam-examples/*' > /etc/dpkg/dpkg.cfg.d/zz-galahad-lab

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip jq ripgrep procps file bc build-essential gfortran cmake pkg-config \
      python3 python3-venv python3-pip python3-dev \
      # numerics, symbolics, statistics, plots, data
      python3-numpy python3-scipy python3-sympy python3-mpmath python3-matplotlib python3-pandas \
      python3-statsmodels python3-networkx python3-h5py python3-astropy python3-cvxopt \
      # finite elements (FEniCSx on PETSc/MPI), meshing
      python3-dolfinx python3-petsc4py python3-mpi4py openmpi-bin libopenmpi-dev gmsh python3-gmsh \
      # CFD, circuits, numerics and computer algebra, SMT
      openfoam openfoam-examples ngspice octave maxima z3 python3-z3 \
 && rm -rf /var/lib/apt/lists/*

# Wheels Debian doesn't package, pinned. Debian's numpy and scipy are pinned as
# constraints so no wheel can shadow the ones FEniCSx was built against.
COPY requirements.txt /opt/lab/requirements.txt
RUN python3 -m venv --system-site-packages /opt/lab \
 && python3 -c "import numpy, scipy; print(f'numpy=={numpy.__version__}\nscipy=={scipy.__version__}')" > /opt/lab/constraints.txt \
 && /opt/lab/bin/pip install --no-cache-dir --disable-pip-version-check -c /opt/lab/constraints.txt -r /opt/lab/requirements.txt \
 && chmod -R a+rX /opt/lab

# The same JS runtime as the workshop image.
ENV BUN_INSTALL=/opt/bun
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4" && chmod -R a+rX /opt/bun

COPY lab-check /usr/local/bin/lab-check
COPY openfoam /usr/local/bin/openfoam
COPY websearch /usr/local/bin/websearch
RUN chmod 0755 /usr/local/bin/lab-check /usr/local/bin/openfoam /usr/local/bin/websearch

RUN useradd --uid 1000 --create-home --home-dir /home/knight --shell /bin/bash knight \
 && mkdir -p /work && chown 1000:1000 /work

# Headless plots. The root is read-only and /tmp is noexec, so caches that hold compiled
# code (FEniCSx's JIT forms) live in the workspace. MPI as a non-root user in a container:
# shared-memory transport without cross-memory attach, and oversubscription allowed.
ENV PATH=/opt/lab/bin:/opt/bun/bin:$PATH \
    MPLBACKEND=Agg MPLCONFIGDIR=/tmp/matplotlib XDG_CACHE_HOME=/work/.cache \
    OMPI_MCA_btl_sm_single_copy_mechanism=none OMPI_MCA_rmaps_base_oversubscribe=1 \
    OMPI_MCA_plm=isolated OMPI_MCA_btl_vader_single_copy_mechanism=none PRTE_MCA_rmaps_default_mapping_policy=:oversubscribe \
    GALAHAD_IMAGE=lab

USER 1000:1000
WORKDIR /work
ENV HOME=/work
CMD ["sleep", "infinity"]
